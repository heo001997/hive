// Event-bus channels + shared types for the System Monitor / debugging panel.
//
// The monitor service runs in the server child process and publishes a snapshot
// of the whole Hive process tree (plus host totals) on a timer, and an alert
// whenever something breaks out (sustained CPU, per-process spike, RSS growth,
// orphan-to-PID-1, event-loop-lag). The renderer subscribes to both channels.

export const SYSTEM_MONITOR_SNAPSHOT_CHANNEL = 'systemMonitor.snapshot'
export const SYSTEM_MONITOR_ALERT_CHANNEL = 'systemMonitor.alert'

/** Classification of a process in the Hive tree, derived from its command line. */
export type MonitorProcessType =
  | 'electron-main'
  | 'electron-renderer'
  | 'electron-gpu'
  | 'electron-utility'
  | 'server'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'mcp-server'
  | 'git'
  | 'shell'
  | 'other'

/** Per-process status flags surfaced as badges in the table. */
export type MonitorProcessFlag = 'HIGH' | 'ORPHAN' | 'RSS_GROWTH'

export interface MonitorProcess {
  pid: number
  ppid: number
  type: MonitorProcessType
  /** Friendly, short display label (e.g. "Claude CLI", "MCP: trello"). */
  label: string
  /** Instantaneous CPU %, computed from cumulative-CPU-seconds delta. */
  cpuPct: number
  /** Resident set size in bytes. */
  rss: number
  /** Cumulative CPU seconds consumed by this process (lifetime). */
  cpuSec: number
  flags: MonitorProcessFlag[]
}

export interface MonitorSnapshot {
  /** ISO-8601 sample time. */
  timestamp: string
  host: {
    cpuCount: number
    /** 1-minute load average (0 on platforms that don't report it, e.g. Windows). */
    loadAvg1: number
    memTotal: number
    memFree: number
  }
  app: {
    /** Sum of per-process CPU % across the monitored tree. */
    cpuPct: number
    /** Sum of RSS (bytes) across the monitored tree. */
    rssTotal: number
    procCount: number
  }
  processes: MonitorProcess[]
  /**
   * Deep self-metrics of the process the monitor runs in (the RPC server child),
   * folded in from perf-diagnostics. Null when unavailable.
   */
  main: {
    eventLoopLagMs: number
    handles: { active: number; byType: Record<string, number> }
  } | null
  platform: NodeJS.Platform
  /** False on platforms without a per-process table (Windows): host + self only. */
  supported: boolean
}

export type MonitorAlertSeverity = 'info' | 'warning' | 'critical'

export type MonitorAlertKind =
  | 'app-cpu-sustained'
  | 'process-cpu-breakout'
  | 'rss-growth'
  | 'orphan-detected'
  | 'event-loop-lag'

export interface MonitorAlert {
  id: string
  /** ISO-8601 time the alert fired. */
  ts: string
  severity: MonitorAlertSeverity
  kind: MonitorAlertKind
  message: string
  pid?: number
}
