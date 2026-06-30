import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, readFileSync } from 'fs'
import { createLogger } from './logger'
import { getHiveLogsDir } from './hive-paths'
import { perfDiagnostics } from './perf-diagnostics'
import { reapOrphans, reapOrphanedMcpServers, MCP_COMMAND_PATTERN } from './orphan-mcp-reaper'
import {
  SYSTEM_MONITOR_SNAPSHOT_CHANNEL,
  SYSTEM_MONITOR_ALERT_CHANNEL,
  type MonitorSnapshot,
  type MonitorProcess,
  type MonitorProcessType,
  type MonitorProcessFlag,
  type MonitorAlert
} from '../../shared/system-monitor-events'

const log = createLogger({ component: 'SystemMonitor' })

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// --- Tunables ---------------------------------------------------------------

const ACTIVE_INTERVAL_MS = 2_000 // panel open: snappy live updates
const BACKGROUND_INTERVAL_MS = 15_000 // enabled but closed: alerts + history
const MAX_HISTORY = 1_000 // ring buffer of snapshots (~30 min @ 2s)
// What getHistory() ships to the renderer on open. The renderer keeps the same
// number for its sparklines, so serialising the full ring just wastes bandwidth.
const RENDERER_HISTORY_LIMIT = 200
const MAX_ALERTS = 200
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_ROTATED_FILES = 2

// Alert thresholds.
export const PROC_CPU_HIGH_PCT = 80 // HIGH badge
export const PROC_CPU_BREAKOUT_PCT = 90 // per-process breakout alert
export const PROC_CPU_SUSTAINED_SAMPLES = 3
export const APP_CPU_SUSTAINED_PCT = 200 // ~2 cores fully pinned by the tree
export const APP_CPU_SUSTAINED_SAMPLES = 3
export const EVENT_LOOP_LAG_MS = 250
export const RSS_GROWTH_MIN_BYTES = 400 * 1024 * 1024
export const RSS_GROWTH_FACTOR = 1.5
const ALERT_COOLDOWN_MS = 60_000

// Ancestors we'll keep climbing through when resolving the app root: Electron
// itself, the dev electron/node launcher, and the macOS app bundle path.
const APP_ANCESTOR_PATTERN = /[Ee]lectron|\.app\/Contents\/MacOS\/|(^|\/)node(\s|$)/

// Agent-CLI command matchers. Single source of truth, shared by classifyProcess
// and the orphan filter so the two can never drift: a CLI we classify as
// claude/codex/opencode is exactly one we'll recognise (and reap) as an orphan.
const CLAUDE_PATTERN = /(^|[/\s])claude(-code|_code)?([/\s-]|$)/i
const CODEX_PATTERN = /(^|[/\s])codex([/\s-]|$)/i
const OPENCODE_PATTERN = /(^|[/\s])opencode([/\s-]|$)/i

// Orphan (ppid===1) commands worth monitoring: MCP servers plus the agent CLIs.
const APP_ORPHAN_PATTERN = new RegExp(
  [MCP_COMMAND_PATTERN, CLAUDE_PATTERN, CODEX_PATTERN, OPENCODE_PATTERN]
    .map((r) => r.source)
    .join('|'),
  'i'
)

// Per-process types that are CPU-bound *by design* and self-terminate, so a
// brief full-core spike is normal work — not a runaway worth a toast. `cpuPct`
// is per-core (100% === one core fully used), so any active `grep` / `git` /
// build step legitimately reads ~100% for the seconds it runs. These types are
// exempt from the per-process CPU-breakout alert. Real trouble is still caught:
// the whole-tree `app-cpu-sustained` alert fires if they collectively pin
// multiple cores, and the orphan / RSS-growth alerts catch leaks. Resident types
// (agent CLIs, MCP servers, the server, Electron procs) are NOT exempt — a core
// pegged there and sustained is a genuine symptom.
export const BREAKOUT_EXEMPT_TYPES: ReadonlySet<MonitorProcessType> = new Set([
  'git',
  'shell',
  'other'
])

/** Whether a per-process CPU breakout for this process type is worth alerting on. */
export function isBreakoutAlertable(type: MonitorProcessType): boolean {
  return !BREAKOUT_EXEMPT_TYPES.has(type)
}

/**
 * Orphans (ppid===1) we may auto-reap the instant we detect them. Only MCP
 * servers qualify: they are never an intentionally-detached session, so killing
 * a leaked one (e.g. trello's un-`unref()`'d `setInterval`) is always safe.
 * Agent-CLI orphans MAY be a user's deliberately detached session, so those stay
 * manual — the `orphan-detected` critical alert plus the panel's force-cleanup.
 */
export function isAutoReapableOrphan(type: MonitorProcessType): boolean {
  return type === 'mcp-server'
}

// --- Pure helpers (exported for unit tests) ---------------------------------

export interface RawProcess {
  pid: number
  ppid: number
  rss: number // bytes
  cpuSec: number // cumulative CPU seconds
  command: string
}

/**
 * Parse `[[DD-]HH:]MM:SS[.ss]` cumulative-CPU time into seconds. Covers macOS
 * (`MM:SS.ss`, `HH:MM:SS`) and Linux (`[[DD-]HH:]MM:SS`) `ps -o time` formats.
 */
export function parseCpuTime(value: string): number {
  if (!value) return 0
  let days = 0
  let rest = value
  const dash = value.indexOf('-')
  if (dash >= 0) {
    days = Number(value.slice(0, dash)) || 0
    rest = value.slice(dash + 1)
  }
  const parts = rest.split(':').map(Number)
  let h = 0
  let m = 0
  let s = 0
  if (parts.length === 3) [h, m, s] = parts
  else if (parts.length === 2) [m, s] = parts
  else if (parts.length === 1) [s] = parts
  if ([days, h, m, s].some((n) => Number.isNaN(n))) return 0
  return days * 86400 + h * 3600 + m * 60 + s
}

/** Parse `ps -Ao pid,ppid,rss,time,command` output into structured rows. */
export function parsePsOutput(stdout: string): RawProcess[] {
  const rows: RawProcess[] = []
  for (const line of stdout.split('\n')) {
    // pid, ppid, rss are integers; time is a single token (no spaces); command
    // is the rest of the line. The header row fails the leading-digit match.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss: Number(match[3]) * 1024, // KiB -> bytes
      cpuSec: parseCpuTime(match[4]),
      command: match[5]
    })
  }
  return rows
}

function commandBasename(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? command
  const base = first.split('/').pop() ?? first
  return base || 'process'
}

function shortMcpName(command: string): string {
  const direct = /mcp-server-([\w.-]+)/i.exec(command)
  if (direct) return direct[1]
  const scoped = /@[\w-]+\/([\w-]+)/.exec(command)
  if (scoped) return scoped[1].replace(/^mcp-server-?/i, '') || scoped[1]
  return 'server'
}

/** Classify a process by its command line into a type + friendly label. */
export function classifyProcess(command: string): {
  type: MonitorProcessType
  label: string
} {
  const c = command
  // Electron subprocess types first — they share the Electron binary path.
  if (/--type=renderer/.test(c)) return { type: 'electron-renderer', label: 'Renderer' }
  if (/--type=gpu-process/.test(c)) return { type: 'electron-gpu', label: 'GPU process' }
  if (/--type=utility/.test(c)) {
    const sub = /--utility-sub-type=([\w.]+)/.exec(c)
    return { type: 'electron-utility', label: sub ? `Utility: ${sub[1]}` : 'Utility process' }
  }
  // The RPC server child (out/server/bin.js).
  if (/server\/bin\.js|\/out\/server\b/.test(c)) return { type: 'server', label: 'Hive Server' }
  // MCP servers (the orphan-prone ones).
  if (MCP_COMMAND_PATTERN.test(c)) return { type: 'mcp-server', label: `MCP: ${shortMcpName(c)}` }
  if (CLAUDE_PATTERN.test(c)) return { type: 'claude', label: 'Claude CLI' }
  if (CODEX_PATTERN.test(c)) return { type: 'codex', label: 'Codex CLI' }
  if (OPENCODE_PATTERN.test(c)) return { type: 'opencode', label: 'opencode CLI' }
  if (/(^|\/)git(\s|$)/.test(c)) return { type: 'git', label: 'git' }
  // Electron main: has the Electron binary but no --type subprocess flag.
  if (/[Ee]lectron|\.app\/Contents\/MacOS\//.test(c)) {
    return { type: 'electron-main', label: 'Electron Main' }
  }
  if (/(^|[/-])(zsh|bash|sh|fish)(\s|$)/.test(c)) return { type: 'shell', label: 'Shell' }
  return { type: 'other', label: commandBasename(c) }
}

/**
 * Resolve the app root by walking up from `startPpid` (the Electron main that
 * spawned this server) to the topmost ancestor still inside the Hive/Electron
 * tree. Stops at PID 1 or the first non-app ancestor (e.g. the login shell).
 */
export function resolveAppRoot(
  byPid: ReadonlyMap<number, { ppid: number; command: string }>,
  startPpid: number
): number {
  let node = startPpid
  let root = startPpid
  const seen = new Set<number>()
  while (!seen.has(node)) {
    seen.add(node)
    const info = byPid.get(node)
    if (!info) break
    root = node
    const parentPid = info.ppid
    if (parentPid <= 1) break
    const parent = byPid.get(parentPid)
    if (!parent || !APP_ANCESTOR_PATTERN.test(parent.command)) break
    node = parentPid
  }
  return root
}

/** The owned process tree: the app root and all of its descendants (BFS). */
export function collectTreePids(procs: readonly RawProcess[], root: number): Set<number> {
  const childIndex = new Map<number, number[]>()
  for (const p of procs) {
    const arr = childIndex.get(p.ppid)
    if (arr) arr.push(p.pid)
    else childIndex.set(p.ppid, [p.pid])
  }
  const tree = new Set<number>()
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift() as number
    if (tree.has(pid)) continue
    tree.add(pid)
    for (const child of childIndex.get(pid) ?? []) queue.push(child)
  }
  return tree
}

/**
 * The monitored set: the owned tree plus any orphans (reparented to PID 1) whose
 * command matches an app pattern (the leak case). Orphans are surfaced for
 * visibility/cleanup but must NOT be folded into the app's resource totals — a
 * PID-1 orphan may belong to a *previous* Hive instance, not this one.
 */
export function collectMonitoredPids(procs: readonly RawProcess[], root: number): Set<number> {
  const monitored = collectTreePids(procs, root)
  for (const p of procs) {
    if (p.ppid === 1 && APP_ORPHAN_PATTERN.test(p.command)) monitored.add(p.pid)
  }
  return monitored
}

/**
 * Instantaneous CPU %, from the delta in cumulative CPU seconds over wall time.
 * Avoids macOS `ps %cpu`'s lifetime-average inaccuracy. 0 on first observation.
 */
export function computeCpuPct(
  curCpuSec: number,
  prevCpuSec: number | undefined,
  wallDeltaSec: number
): number {
  if (prevCpuSec === undefined || wallDeltaSec <= 0) return 0
  const delta = curCpuSec - prevCpuSec
  if (delta <= 0) return 0
  return Math.round((delta / wallDeltaSec) * 100 * 100) / 100
}

/** Per-process status flags. `baselineRss` is the first-seen RSS, if known. */
export function computeProcessFlags(
  proc: { cpuPct: number; rss: number; ppid: number },
  baselineRss?: number
): MonitorProcessFlag[] {
  const flags: MonitorProcessFlag[] = []
  if (proc.cpuPct >= PROC_CPU_HIGH_PCT) flags.push('HIGH')
  if (proc.ppid === 1) flags.push('ORPHAN')
  if (
    baselineRss !== undefined &&
    proc.rss >= RSS_GROWTH_MIN_BYTES &&
    proc.rss > baselineRss * RSS_GROWTH_FACTOR
  ) {
    flags.push('RSS_GROWTH')
  }
  return flags
}

export interface HostCpuTimes {
  idle: number
  total: number
}

/** Sum os.cpus() per-core cumulative tick counters into a single {idle,total}. */
export function sumCpuTimes(cpus: os.CpuInfo[]): HostCpuTimes {
  let idle = 0
  let total = 0
  for (const c of cpus) {
    for (const k of Object.keys(c.times) as (keyof os.CpuInfo['times'])[]) {
      const v = c.times[k]
      total += v
      if (k === 'idle') idle += v
    }
  }
  return { idle, total }
}

/**
 * Whole-machine CPU utilisation % (0–100) from the idle-vs-total tick delta
 * between two os.cpus() reads — the instantaneous busy-ness Activity Monitor
 * shows. 0 on the first read or a non-positive window. This deliberately
 * replaces the 1-minute load average as the headline CPU figure: load is a
 * lagging run-queue EWMA, not utilisation, so it both over-reads and trails
 * reality (the "monitor says maxed while Activity Monitor is calm" bug).
 */
export function computeHostCpuPct(prev: HostCpuTimes | null, cur: HostCpuTimes): number {
  if (!prev) return 0
  const idleDelta = cur.idle - prev.idle
  const totalDelta = cur.total - prev.total
  if (totalDelta <= 0) return 0
  const pct = (1 - idleDelta / totalDelta) * 100
  return Math.round(Math.min(100, Math.max(0, pct)) * 100) / 100
}

/**
 * macOS *available* memory in bytes from `vm_stat`: free + reclaimable
 * (inactive + speculative + purgeable) pages × page size. Returns null if the
 * output can't be parsed (caller falls back to os.freemem()).
 *
 * Why this exists: os.freemem() counts only the tiny pool of truly-free pages,
 * treating macOS's large file-cache / inactive / purgeable reserve as "used".
 * That makes (memTotal - freemem) read ~95–99% on a perfectly healthy machine —
 * the exact discrepancy users see vs Activity Monitor. The reclaimable buckets
 * here are freed on demand without swapping, so they ARE available.
 */
export function parseVmStatAvailable(stdout: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  const pages = (label: string): number =>
    Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0)
  const free = pages('free')
  const inactive = pages('inactive')
  // free + inactive are always present on a real vm_stat; if both are 0 the
  // output didn't parse (e.g. localisation), so signal failure rather than 0 B.
  if (free + inactive === 0) return null
  return (free + inactive + pages('speculative') + pages('purgeable')) * pageSize
}

/** Linux *available* memory in bytes from /proc/meminfo's MemAvailable (kB). */
export function parseMemAvailableLinux(meminfo: string): number | null {
  const kb = Number(/MemAvailable:\s+(\d+)\s*kB/.exec(meminfo)?.[1])
  return Number.isFinite(kb) ? kb * 1024 : null
}

/** Host metrics that need no cross-sample state or external commands. */
function readHostBase(): Omit<MonitorSnapshot['host'], 'cpuPct' | 'memAvailable'> {
  return {
    cpuCount: os.cpus().length,
    loadAvg1: os.loadavg()[0] ?? 0,
    memTotal: os.totalmem(),
    memFree: os.freemem()
  }
}

// --- Service ----------------------------------------------------------------

type Publisher = (channel: string, payload: unknown) => void

class SystemMonitorService {
  private enabled = false // background sampling (alerts + history)
  private active = false // panel open -> fast cadence
  private timer: NodeJS.Timeout | null = null
  private currentIntervalMs = 0
  private sampling = false

  private prevCpu = new Map<number, number>()
  private prevWallMs = 0
  private prevCpuTimes: HostCpuTimes | null = null
  private rssBaseline = new Map<number, number>()
  private appCpuSustain = 0
  private appCpuAlerted = false // edge-trigger latch for the app-CPU episode
  private procCpuSustain = new Map<number, number>()
  private procCpuAlerted = new Set<number>() // pids already alerted this breakout
  private alertedOrphans = new Set<number>() // pids already alerted while orphaned
  private alertCooldown = new Map<string, number>()
  private alertSeq = 0

  private history: MonitorSnapshot[] = []
  private alerts: MonitorAlert[] = []
  private lastSnapshot: MonitorSnapshot | null = null

  private publisher: Publisher | null = null
  private readonly logDir = getHiveLogsDir()
  private readonly logFile = join(getHiveLogsDir(), 'system-monitor.jsonl')
  private readonly alertLogFile = join(getHiveLogsDir(), 'monitor-alerts.jsonl')

  setPublisher(publisher: Publisher | null): void {
    this.publisher = publisher
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    // Disabling must fully stop sampling — clear the panel-open fast-cadence flag
    // too, otherwise `active` keeps the timer alive after the user turns it off.
    if (!enabled) this.active = false
    log.info('System monitor enabled changed', { enabled })
    this.reschedule()
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.reschedule()
    // Sample immediately on open so the panel paints without waiting a tick.
    if (active) void this.sample()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getSnapshot(): MonitorSnapshot {
    return this.lastSnapshot ?? this.buildHostOnlySnapshot()
  }

  getHistory(): MonitorSnapshot[] {
    return this.history.slice(-RENDERER_HISTORY_LIMIT)
  }

  getAlerts(): MonitorAlert[] {
    return [...this.alerts]
  }

  cleanup(): void {
    this.enabled = false
    this.active = false
    this.reschedule()
  }

  /**
   * Signal a process (optionally its whole group, like PtyService.destroy):
   * SIGTERM for a clean exit, then an unref'd SIGKILL backstop for stragglers.
   *
   * Group kill targets `-pgid`, where pgid is the target's *resolved* process
   * group id — never a bare `-pid`. A pid is not necessarily its own group
   * leader, so `process.kill(-pid)` would silently miss (ESRCH) or, worse, signal
   * an unrelated group. If we can't resolve a safe pgid we fall back to a
   * single-pid signal.
   */
  async killProcess(pid: number, group = false): Promise<void> {
    let target = pid
    let useGroup = false
    if (group && process.platform !== 'win32') {
      const pgid = await this.resolvePgid(pid)
      if (pgid !== null && pgid > 1 && pgid !== process.pid) {
        target = -pgid
        useGroup = true
      }
    }
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(target, sig)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ESRCH') log.warn('Failed to signal process', { pid, group: useGroup, sig, code })
      }
    }
    log.info('Killing process from monitor', { pid, group: useGroup })
    signal('SIGTERM')
    setTimeout(() => signal('SIGKILL'), 2000).unref?.()
  }

  /** Resolve a pid's process-group id via `ps`. Null if it can't be determined. */
  private resolvePgid(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
      exec(`ps -o pgid= -p ${pid}`, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const pgid = Number(stdout.trim())
        resolve(Number.isFinite(pgid) && pgid > 0 ? pgid : null)
      })
    })
  }

  /**
   * Reap orphaned MCP servers (ppid===1) the instant the sampler spots one,
   * instead of waiting for the 10-min periodic reaper. `reapOrphanedMcpServers`
   * re-scans `ps` and only signals processes that are *still* PID-1 orphans
   * matching the MCP pattern, so acting on a stale sample can't hit a recycled
   * pid. Reported as a single non-intrusive info alert (no critical toast).
   */
  private async autoReapMcpOrphans(detected: number): Promise<void> {
    try {
      const killed = await reapOrphanedMcpServers()
      log.info('Auto-reaped orphaned MCP servers on detection', { detected, killed })
      if (killed > 0) {
        this.emitAlert({
          severity: 'info',
          kind: 'orphan-detected',
          message: `Auto-reaped ${killed} orphaned MCP server${killed === 1 ? '' : 's'} reparented to PID 1`
        })
      }
    } catch (err) {
      log.warn('Auto-reap of orphaned MCP servers failed', { err: String(err) })
    }
  }

  async cleanupOrphans(): Promise<number> {
    // Reap the *full* set of app orphans the monitor flags (MCP servers + agent
    // CLIs), not just MCP — otherwise the button reports "nothing found" while
    // orphaned claude/codex/opencode it just alerted on keep leaking.
    const killed = await reapOrphans(APP_ORPHAN_PATTERN)
    log.info('Force orphan cleanup from monitor', { killed })
    return killed
  }

  // --- internals ---

  private reschedule(): void {
    const shouldRun = this.enabled || this.active
    const desired = this.active ? ACTIVE_INTERVAL_MS : BACKGROUND_INTERVAL_MS
    if (!shouldRun) {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
        this.currentIntervalMs = 0
      }
      return
    }
    if (this.timer && this.currentIntervalMs === desired) return
    if (this.timer) clearInterval(this.timer)
    this.ensureLogDir()
    this.currentIntervalMs = desired
    this.timer = setInterval(() => void this.sample(), desired)
    // Unref'd so the sampler never keeps the process alive (the orphan-leak lesson).
    this.timer.unref?.()
    void this.sample()
  }

  private safePerfSnapshot(): MonitorSnapshot['main'] {
    try {
      const perf = perfDiagnostics.getSnapshot()
      return {
        eventLoopLagMs: perf.eventLoopLagMs,
        handles: { active: perf.handles.active, byType: perf.handles.byType }
      }
    } catch {
      return null
    }
  }

  /**
   * Instantaneous host CPU % from the os.cpus() tick delta. STATEFUL — advances
   * prevCpuTimes, so it must be called exactly once per sample (never from the
   * non-sampling getSnapshot() fallback, or it would steal the next sample's
   * delta and read ~0).
   */
  private hostCpuPct(): number {
    const cur = sumCpuTimes(os.cpus())
    const pct = computeHostCpuPct(this.prevCpuTimes, cur)
    this.prevCpuTimes = cur
    return pct
  }

  /** OS-accurate available memory (bytes); falls back to os.freemem() on error. */
  private async readMemAvailable(memFree: number): Promise<number> {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('vm_stat', [], { timeout: 4_000 })
        return parseVmStatAvailable(stdout) ?? memFree
      }
      if (process.platform === 'linux') {
        return parseMemAvailableLinux(readFileSync('/proc/meminfo', 'utf8')) ?? memFree
      }
    } catch (err) {
      log.warn('readMemAvailable failed; falling back to freemem', { err: String(err) })
    }
    return memFree // Windows / unknown: os.freemem() is the best we have.
  }

  private buildHostOnlySnapshot(): MonitorSnapshot {
    const main = this.safePerfSnapshot()
    const base = readHostBase()
    return {
      timestamp: new Date().toISOString(),
      // Placeholder snapshot (no sample yet): don't touch the CPU-delta state and
      // use freemem as a stand-in until the first real sample lands.
      host: { ...base, cpuPct: 0, memAvailable: base.memFree },
      app: { cpuPct: 0, rssTotal: 0, procCount: 0 },
      processes: [],
      main,
      platform: process.platform,
      supported: process.platform !== 'win32'
    }
  }

  private async sample(): Promise<void> {
    if (this.sampling) return
    this.sampling = true
    try {
      const snapshot =
        process.platform === 'win32'
          ? this.buildWindowsSnapshot()
          : await this.buildTreeSnapshot()
      this.lastSnapshot = snapshot
      this.pushHistory(snapshot)
      this.appendLog(this.logFile, snapshot)
      this.publisher?.(SYSTEM_MONITOR_SNAPSHOT_CHANNEL, snapshot)
      this.runAlerts(snapshot)
    } catch (err) {
      log.warn('System monitor sample failed', { err: String(err) })
    } finally {
      this.sampling = false
    }
  }

  private buildWindowsSnapshot(): MonitorSnapshot {
    // No per-process `ps` table on Windows — report host + server self metrics.
    const main = this.safePerfSnapshot()
    let app = { cpuPct: 0, rssTotal: 0, procCount: 0 }
    try {
      const perf = perfDiagnostics.getSnapshot()
      app = { cpuPct: perf.cpu.percentSinceLastSample, rssTotal: perf.memory.rss, procCount: 1 }
    } catch {
      // keep zeros
    }
    const base = readHostBase()
    return {
      timestamp: new Date().toISOString(),
      // os.freemem() is reasonably accurate on Windows, so it doubles as
      // memAvailable there; CPU% still comes from the os.cpus() tick delta.
      host: { ...base, cpuPct: this.hostCpuPct(), memAvailable: base.memFree },
      app,
      processes: [],
      main,
      platform: process.platform,
      supported: false
    }
  }

  private async buildTreeSnapshot(): Promise<MonitorSnapshot> {
    const base = readHostBase()
    // ps (process tree) and vm_stat (host memory) are independent — run them
    // concurrently so the extra memory read adds no latency to the 2s cadence.
    const [{ stdout }, memAvailable] = await Promise.all([
      execAsync('ps -Ao pid,ppid,rss,time,command', { maxBuffer: 16 * 1024 * 1024 }),
      this.readMemAvailable(base.memFree)
    ])
    const hostCpuPct = this.hostCpuPct()
    const wallNowMs = Date.now()
    const raw = parsePsOutput(stdout)
    const byPid = new Map(raw.map((r) => [r.pid, r]))
    let root = resolveAppRoot(byPid, process.ppid)
    // If the resolved root isn't a live process (e.g. ps didn't capture our
    // ppid), fall back to this server process so the panel still shows our
    // own subtree instead of going blank.
    if (!byPid.has(root)) root = process.pid
    const tree = collectTreePids(raw, root)
    const monitored = collectMonitoredPids(raw, root)
    const wallDeltaSec = this.prevWallMs ? (wallNowMs - this.prevWallMs) / 1000 : 0

    const nextPrevCpu = new Map<number, number>()
    const nextBaseline = new Map<number, number>()
    const processes: MonitorProcess[] = []
    let appCpu = 0
    let appRss = 0
    let appProcCount = 0

    for (const pid of monitored) {
      const r = byPid.get(pid)
      if (!r) continue
      const cpuPct = computeCpuPct(r.cpuSec, this.prevCpu.get(pid), wallDeltaSec)
      const { type, label } = classifyProcess(r.command)
      const baseline = this.rssBaseline.get(pid) ?? r.rss
      const flags = computeProcessFlags({ cpuPct, rss: r.rss, ppid: r.ppid }, baseline)
      processes.push({
        pid,
        ppid: r.ppid,
        type,
        label,
        cpuPct,
        rss: r.rss,
        cpuSec: r.cpuSec,
        flags
      })
      // Only the owned tree counts toward the app's footprint; orphans are
      // shown (flagged) but may belong to a previous instance.
      if (tree.has(pid)) {
        appCpu += cpuPct
        appRss += r.rss
        appProcCount++
      }
      nextPrevCpu.set(pid, r.cpuSec)
      nextBaseline.set(pid, this.rssBaseline.get(pid) ?? r.rss)
    }

    processes.sort((a, b) => b.cpuPct - a.cpuPct || b.rss - a.rss)
    this.prevCpu = nextPrevCpu
    this.rssBaseline = nextBaseline
    this.prevWallMs = wallNowMs

    return {
      timestamp: new Date(wallNowMs).toISOString(),
      host: { ...base, cpuPct: hostCpuPct, memAvailable },
      app: {
        cpuPct: Math.round(appCpu * 100) / 100,
        rssTotal: appRss,
        procCount: appProcCount
      },
      processes,
      main: this.safePerfSnapshot(),
      platform: process.platform,
      supported: true
    }
  }

  private runAlerts(s: MonitorSnapshot): void {
    // Sustained whole-app CPU — edge-triggered: fire once when the episode
    // starts, re-arm only after CPU drops back below threshold. Avoids a fresh
    // toast every cooldown for a condition that's simply still true.
    if (s.app.cpuPct >= APP_CPU_SUSTAINED_PCT) {
      this.appCpuSustain++
      if (this.appCpuSustain >= APP_CPU_SUSTAINED_SAMPLES && !this.appCpuAlerted) {
        this.appCpuAlerted = true
        this.emitAlert({
          severity: 'warning',
          kind: 'app-cpu-sustained',
          message: `Hive CPU sustained at ${s.app.cpuPct.toFixed(0)}% across ${this.appCpuSustain} samples`
        })
      }
    } else {
      this.appCpuSustain = 0
      this.appCpuAlerted = false
    }

    const seen = new Set<number>()
    const orphanPids = new Set<number>()
    let newMcpOrphans = 0
    for (const p of s.processes) {
      seen.add(p.pid)
      // Skip transient CPU-bound tools (grep, git, build steps, shells): a full
      // core for a few seconds is them doing their job, not a runaway. Only
      // resident process types can trip the per-process breakout.
      if (isBreakoutAlertable(p.type)) {
        if (p.cpuPct >= PROC_CPU_BREAKOUT_PCT) {
          const count = (this.procCpuSustain.get(p.pid) ?? 0) + 1
          this.procCpuSustain.set(p.pid, count)
          if (count >= PROC_CPU_SUSTAINED_SAMPLES && !this.procCpuAlerted.has(p.pid)) {
            this.procCpuAlerted.add(p.pid)
            this.emitAlert({
              severity: 'warning',
              kind: 'process-cpu-breakout',
              message: `${p.label} (pid ${p.pid}) at ${p.cpuPct.toFixed(0)}% CPU`,
              pid: p.pid
            })
          }
        } else {
          this.procCpuSustain.set(p.pid, 0)
          this.procCpuAlerted.delete(p.pid) // re-arm for the next breakout
        }
      }

      if (p.flags.includes('RSS_GROWTH')) {
        this.emitAlert({
          severity: 'warning',
          kind: 'rss-growth',
          message: `${p.label} (pid ${p.pid}) RSS grew to ${(p.rss / 1048576).toFixed(0)} MB`,
          pid: p.pid
        })
        // Ratchet the baseline up to the current size so we only alert again on
        // *further* growth — not every sample forever once a process grew once.
        this.rssBaseline.set(p.pid, p.rss)
      }
      if (p.flags.includes('ORPHAN')) {
        orphanPids.add(p.pid)
        if (!this.alertedOrphans.has(p.pid)) {
          this.alertedOrphans.add(p.pid)
          if (isAutoReapableOrphan(p.type)) {
            // Leaked MCP server (never an intentional detach) — reap now instead
            // of waiting up to 10 min for the periodic sweep. The actual reap +
            // a single non-intrusive info alert happen once, after the loop.
            newMcpOrphans++
          } else {
            // Agent-CLI orphan: may be a deliberately detached session, so never
            // auto-kill it — surface it for manual cleanup instead.
            this.emitAlert({
              severity: 'critical',
              kind: 'orphan-detected',
              message: `Orphaned ${p.label} (pid ${p.pid}) reparented to PID 1`,
              pid: p.pid
            })
          }
        }
      }
    }
    // Drop trackers for processes that have gone away so the maps/sets stay
    // bounded and a recycled pid re-alerts cleanly.
    for (const pid of [...this.procCpuSustain.keys()]) {
      if (!seen.has(pid)) {
        this.procCpuSustain.delete(pid)
        this.procCpuAlerted.delete(pid)
      }
    }
    for (const pid of [...this.alertedOrphans]) {
      if (!orphanPids.has(pid)) this.alertedOrphans.delete(pid)
    }

    // Self-heal leaked MCP servers the moment we see them, rather than leaving
    // them to pile up until the 10-min periodic reaper runs.
    if (newMcpOrphans > 0) void this.autoReapMcpOrphans(newMcpOrphans)

    if (s.main && s.main.eventLoopLagMs >= EVENT_LOOP_LAG_MS) {
      this.emitAlert({
        severity: 'warning',
        kind: 'event-loop-lag',
        message: `Server event-loop lag ${s.main.eventLoopLagMs.toFixed(0)} ms`
      })
    }
  }

  private emitAlert(candidate: Omit<MonitorAlert, 'id' | 'ts'>): void {
    const now = Date.now()
    // Drop expired cooldown entries every emit so the map can't grow unbounded
    // (one key per kind:pid that ever alerted) over the server's lifetime.
    for (const [k, t] of this.alertCooldown) {
      if (now - t >= ALERT_COOLDOWN_MS) this.alertCooldown.delete(k)
    }
    const key = `${candidate.kind}:${candidate.pid ?? 'global'}`
    const last = this.alertCooldown.get(key) ?? 0
    if (now - last < ALERT_COOLDOWN_MS) return // de-dupe: one breakout != a toast storm
    this.alertCooldown.set(key, now)
    const alert: MonitorAlert = { id: `${now}-${++this.alertSeq}`, ts: new Date(now).toISOString(), ...candidate }
    this.alerts.push(alert)
    if (this.alerts.length > MAX_ALERTS) this.alerts.shift()
    this.appendLog(this.alertLogFile, alert)
    this.publisher?.(SYSTEM_MONITOR_ALERT_CHANNEL, alert)
    log.info('Monitor alert', { kind: alert.kind, pid: alert.pid, message: alert.message })
  }

  private pushHistory(snapshot: MonitorSnapshot): void {
    this.history.push(snapshot)
    if (this.history.length > MAX_HISTORY) this.history.shift()
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      try {
        mkdirSync(this.logDir, { recursive: true })
      } catch {
        // ignore
      }
    }
  }

  private appendLog(file: string, value: unknown): void {
    try {
      this.rotateIfNeeded(file)
      appendFileSync(file, JSON.stringify(value) + '\n')
    } catch {
      // Logging is best-effort; a write failure must never break sampling.
    }
  }

  private rotateIfNeeded(file: string): void {
    try {
      if (!existsSync(file)) return
      if (statSync(file).size < MAX_LOG_SIZE) return
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const from = `${file}.${i}`
        const to = `${file}.${i + 1}`
        if (existsSync(from)) {
          try {
            renameSync(from, to)
          } catch {
            // ignore
          }
        }
      }
      renameSync(file, `${file}.1`)
    } catch {
      // ignore rotation errors
    }
  }
}

let instance: SystemMonitorService | null = null

const getSystemMonitor = (): SystemMonitorService => {
  instance ??= new SystemMonitorService()
  return instance
}

export const systemMonitor = {
  setPublisher: (publisher: Publisher | null): void => getSystemMonitor().setPublisher(publisher),
  setEnabled: (enabled: boolean): void => getSystemMonitor().setEnabled(enabled),
  setActive: (active: boolean): void => getSystemMonitor().setActive(active),
  isEnabled: (): boolean => getSystemMonitor().isEnabled(),
  getSnapshot: (): MonitorSnapshot => getSystemMonitor().getSnapshot(),
  getHistory: (): MonitorSnapshot[] => getSystemMonitor().getHistory(),
  getAlerts: (): MonitorAlert[] => getSystemMonitor().getAlerts(),
  killProcess: (pid: number, group = false): Promise<void> =>
    getSystemMonitor().killProcess(pid, group),
  cleanupOrphans: (): Promise<number> => getSystemMonitor().cleanupOrphans(),
  cleanup: (): void => getSystemMonitor().cleanup()
}
