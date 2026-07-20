// Node-side backend discovery + bootstrap-token resolution + connected-client
// factory. Factored out of resources/cli/hive-ticket.mjs (discoverBackends /
// selectInstance / resolveBootstrapTokenFor / getWebSocketToken) and typed. This
// is the ONLY file in @hive/client that touches Node built-ins; it is reachable
// only through the `@hive/client/node` subpath, never from the DOM-free root.
//
// The desktop app picks the first free port in [3773..3873] and several
// instances can run at once (production, `pnpm dev`, one per worktree). We scan
// the whole range in parallel and select deterministically — never guess.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { HiveClient } from '../hive-client'
import type { TokenStore } from '../token-store'
import type { FetchLike, WebSocketImpl } from '../types'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT_START = 3773
const DEFAULT_PORT_END = 3873

export interface DiscoveredBackend {
  readonly host: string
  readonly port: number
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly hasDesktopBootstrapToken: boolean
  readonly mode?: string
  readonly instanceKind?: string
  readonly label?: string
  readonly appVersion?: string
  readonly dataDir?: string
  readonly repoRoot?: string
  readonly pid?: number
  readonly startedAt?: string
}

export interface DiscoverBackendsOptions {
  readonly host?: string
  readonly portStart?: number
  readonly portEnd?: number
  /** Per-port probe timeout in ms (default 400). */
  readonly timeoutMs?: number
  readonly fetchImpl?: FetchLike
}

interface EnvironmentBody {
  host?: string
  port?: number
  httpBaseUrl?: string
  wsBaseUrl?: unknown
  hasDesktopBootstrapToken?: unknown
  mode?: string
  instanceKind?: string
  label?: string
  appVersion?: string
  dataDir?: string
  repoRoot?: string
  pid?: number
  startedAt?: string
}

const getGlobalFetch = (impl?: FetchLike): FetchLike => {
  if (impl) return impl
  const candidate = (globalThis as { fetch?: FetchLike }).fetch
  if (!candidate) throw new Error('Node global fetch unavailable — run with Node >=18.')
  return candidate
}

async function fetchJson(
  doFetch: FetchLike,
  url: string,
  init: Record<string, unknown> = {},
  timeoutMs = 1500
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await doFetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let body: Record<string, unknown>
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      body = { raw: text }
    }
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// Scan the desktop port range IN PARALLEL and return every live Hive backend with
// its identity. Node's fetch sends no Origin header, so the server includes the
// identity fields (mode, instanceKind, label, dataDir, repoRoot, …) for us.
export async function discoverBackends(
  options: DiscoverBackendsOptions = {}
): Promise<DiscoveredBackend[]> {
  const host = options.host ?? DEFAULT_HOST
  const portStart = options.portStart ?? DEFAULT_PORT_START
  const portEnd = options.portEnd ?? DEFAULT_PORT_END
  const timeoutMs = options.timeoutMs ?? 400
  const doFetch = getGlobalFetch(options.fetchImpl)

  const ports: number[] = []
  for (let p = portStart; p <= portEnd; p += 1) ports.push(p)

  const results = await Promise.all(
    ports.map(async (port): Promise<DiscoveredBackend | null> => {
      try {
        const { ok, body } = await fetchJson(
          doFetch,
          `http://${host}:${port}/.well-known/hive/environment`,
          {},
          timeoutMs
        )
        const env = body as EnvironmentBody
        if (ok && env && typeof env.wsBaseUrl === 'string') {
          return {
            host: env.host || host,
            port: env.port || port,
            httpBaseUrl: env.httpBaseUrl || `http://${host}:${port}`,
            wsBaseUrl: env.wsBaseUrl,
            hasDesktopBootstrapToken: Boolean(env.hasDesktopBootstrapToken),
            mode: env.mode,
            instanceKind: env.instanceKind,
            label: env.label,
            appVersion: env.appVersion,
            dataDir: env.dataDir,
            repoRoot: env.repoRoot,
            pid: env.pid,
            startedAt: env.startedAt
          }
        }
      } catch {
        // port not listening / not hive — ignore
      }
      return null
    })
  )
  return results.filter((r): r is DiscoveredBackend => r !== null)
}

export function describeBackend(i: DiscoveredBackend): string {
  const kind = i.instanceKind || i.mode || (i.hasDesktopBootstrapToken ? 'desktop' : 'server')
  const label = i.label || i.repoRoot || i.dataDir || '(unknown)'
  const ver = i.appVersion ? ` · v${i.appVersion}` : ''
  return `${label}  [${kind} · :${i.port}${ver}]`
}

function listBlock(list: DiscoveredBackend[]): string {
  return list
    .map((i) => `  - ${describeBackend(i)}${i.repoRoot ? `\n      ${i.repoRoot}` : ''}`)
    .join('\n')
}

function pathEq(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b)
  } catch {
    return false
  }
}

function isUnder(child: string, parent: string): boolean {
  try {
    const p = resolve(parent)
    const c = resolve(child)
    return c === p || c.startsWith(p + sep)
  } catch {
    return false
  }
}

// This shell's data dir (matches a worktree's HIVE_DATA_DIR when set).
export function selfDataDir(): string {
  const d = process.env.HIVE_DATA_DIR?.trim()
  return resolve(d || join(homedir(), '.hive'))
}

// This shell's git toplevel, if any — used to match the instance bound to the
// same repo/worktree.
export function gitToplevel(): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim() || null
  } catch {
    return null
  }
}

export interface SelectContext {
  readonly wantPort?: number | null
  readonly wantInstance?: string | null
  readonly cwd?: string
  readonly dataDir?: string
  readonly gitToplevel?: string | null
}

// Is this instance the one bound to the repo/worktree this shell is in?
export function isContextMatch(i: DiscoveredBackend, ctx: SelectContext): boolean {
  if (i.dataDir && ctx.dataDir && pathEq(i.dataDir, ctx.dataDir)) return true
  if (i.repoRoot && ctx.gitToplevel && pathEq(i.repoRoot, ctx.gitToplevel)) return true
  if (i.repoRoot && ctx.cwd && isUnder(ctx.cwd, i.repoRoot)) return true
  return false
}

// Block accidental writes to the production board: a prod instance must be chosen
// explicitly (--instance / --port), never via auto-match or sole-instance.
function guardImplicit(instance: DiscoveredBackend, all: DiscoveredBackend[]): DiscoveredBackend {
  if (instance.instanceKind === 'production') {
    throw new Error(
      'Refusing to target the PRODUCTION Hive implicitly (safety guard).\n' +
        `Confirm explicitly with  instance: "production"  (or  port: ${instance.port}).\n\n` +
        'Running instances:\n' +
        listBlock(all)
    )
  }
  return instance
}

// Deterministic instance pick (mirrors the CLI's selectInstance). Throws with a
// descriptive message when selection can't proceed — never guesses.
export function selectBackend(
  backends: DiscoveredBackend[],
  ctx: SelectContext = {}
): DiscoveredBackend {
  if (backends.length === 0) throw new Error('No live Hive backends to select from.')

  // 1. Explicit port wins outright (no guard — the caller named it).
  if (ctx.wantPort != null) {
    const m = backends.find((i) => i.port === ctx.wantPort)
    if (!m) throw new Error(`No live Hive on port ${ctx.wantPort}. Running instances:\n${listBlock(backends)}`)
    return m
  }

  // 2. Explicit instance string — match label / kind / repoRoot / dataDir / port.
  if (ctx.wantInstance) {
    const q = String(ctx.wantInstance).toLowerCase()
    const matches = backends.filter(
      (i) =>
        (i.label || '').toLowerCase().includes(q) ||
        (i.instanceKind || '').toLowerCase() === q ||
        (i.repoRoot || '').toLowerCase().includes(q) ||
        (i.dataDir || '').toLowerCase().includes(q) ||
        String(i.port) === q
    )
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) {
      throw new Error(`No Hive instance matches "${ctx.wantInstance}". Running instances:\n${listBlock(backends)}`)
    }
    throw new Error(`"${ctx.wantInstance}" is ambiguous:\n${listBlock(matches)}`)
  }

  // 3. Context auto-match: the Hive for the repo/worktree this shell is in.
  const auto = backends.filter((i) => isContextMatch(i, ctx))
  if (auto.length === 1) return guardImplicit(auto[0], backends)

  // 4. Exactly one instance alive.
  if (backends.length === 1) return guardImplicit(backends[0], backends)

  // 5. Ambiguous — never guess.
  throw new Error(
    'Multiple Hive instances are running — choose one with  instance: <name|kind>  or  port: <n>:\n' +
      listBlock(backends)
  )
}

// Find the bootstrap token for the SELECTED instance, most robust source first:
// 1) $HIVE_DESKTOP_BOOTSTRAP_TOKEN, 2) the instance's own cli.json (port-checked),
// 3) the running app's argv (ps), matched to this instance by port.
export function resolveBootstrapTokenFor(instance: DiscoveredBackend): string | null {
  const fromEnv = process.env.HIVE_DESKTOP_BOOTSTRAP_TOKEN?.trim()
  if (fromEnv) return fromEnv

  try {
    const dir = instance.dataDir || selfDataDir()
    const file = join(dir, 'cli.json')
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { bootstrapToken?: unknown; port?: unknown }
      const tok = j?.bootstrapToken ? String(j.bootstrapToken).trim() : ''
      if (tok && (j.port == null || j.port === instance.port)) return tok
    }
  } catch {
    // unreadable / malformed — fall through to argv scrape
  }

  try {
    const ps = execSync('ps -axww -o command=', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    for (const m of ps.matchAll(/hive-local-environment-bootstrap=(\S+)/g)) {
      try {
        const obj = JSON.parse(decodeURIComponent(m[1])) as {
          wsBaseUrl?: unknown
          httpBaseUrl?: unknown
          port?: unknown
          bootstrapToken?: unknown
        }
        let port: number | null = null
        if (typeof obj?.wsBaseUrl === 'string') port = Number(new URL(obj.wsBaseUrl).port)
        else if (typeof obj?.httpBaseUrl === 'string') port = Number(new URL(obj.httpBaseUrl).port)
        else if (obj?.port != null) port = Number(obj.port)
        const tok = obj?.bootstrapToken ? String(obj.bootstrapToken).trim() : ''
        if (tok && port === instance.port) return tok
      } catch {
        // bad blob — try the next
      }
    }
  } catch {
    // ps unavailable — give up; caller handles the token-less path
  }

  return null
}

export interface NodeHiveClientOptions {
  readonly host?: string
  readonly portStart?: number
  readonly portEnd?: number
  /** Select a specific instance by exact port. */
  readonly port?: number | null
  /** Select by label / kind / repoRoot / dataDir substring. */
  readonly instance?: string | null
  /** Override the bootstrap token; otherwise resolved from env/cli.json/ps. */
  readonly bootstrapToken?: string | null
  readonly tokenStore?: TokenStore
  readonly fetchImpl?: FetchLike
  /** Defaults to Node's global `WebSocket` (>=22). */
  readonly webSocketImpl?: WebSocketImpl
}

export interface NodeHiveClientResult {
  readonly client: HiveClient
  readonly backend: DiscoveredBackend
  /** True when a bootstrap token was found (authenticated); false = token-less. */
  readonly authenticated: boolean
}

// Discover -> select -> resolve bootstrap token -> build a connected HiveClient.
// The client mints a fresh WS token per connect via the shared handshake.
export async function createNodeHiveClient(
  options: NodeHiveClientOptions = {}
): Promise<NodeHiveClientResult> {
  const backends = await discoverBackends({
    host: options.host,
    portStart: options.portStart,
    portEnd: options.portEnd,
    fetchImpl: options.fetchImpl
  })
  if (backends.length === 0) {
    const host = options.host ?? DEFAULT_HOST
    const start = options.portStart ?? DEFAULT_PORT_START
    const end = options.portEnd ?? DEFAULT_PORT_END
    throw new Error(
      `Cannot reach any Hive on ${host}:${start}-${end}. Is the app running? ` +
        '(Override the host with the `host` option if it listens elsewhere.)'
    )
  }

  const backend = selectBackend(backends, {
    wantPort: options.port ?? null,
    wantInstance: options.instance ?? null,
    cwd: process.cwd(),
    dataDir: selfDataDir(),
    gitToplevel: gitToplevel()
  })

  const bootstrapToken = options.bootstrapToken ?? resolveBootstrapTokenFor(backend)
  if (!bootstrapToken && backend.hasDesktopBootstrapToken) {
    throw new Error(
      'This Hive requires auth but its bootstrap token could not be found. Tried ' +
        "$HIVE_DESKTOP_BOOTSTRAP_TOKEN, the instance's cli.json, and the running app's argv (ps). " +
        'For a signed/notarized app that hides its argv, pass `bootstrapToken` explicitly.'
    )
  }

  const client = new HiveClient({
    baseUrl: backend.wsBaseUrl,
    httpBaseUrl: backend.httpBaseUrl,
    bootstrapToken: bootstrapToken ?? null,
    tokenStore: options.tokenStore,
    fetchImpl: options.fetchImpl,
    webSocketImpl: options.webSocketImpl
  })

  return { client, backend, authenticated: Boolean(bootstrapToken) }
}
