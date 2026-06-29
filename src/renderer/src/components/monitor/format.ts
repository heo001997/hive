import type { MonitorProcessType } from '@shared/system-monitor-events'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  if (mb >= 10) return `${mb.toFixed(0)} MB`
  return `${mb.toFixed(1)} MB`
}

export function formatPct(value: number): string {
  return `${value.toFixed(value >= 100 ? 0 : 1)}%`
}

const TYPE_LABELS: Record<MonitorProcessType, string> = {
  'electron-main': 'Main',
  'electron-renderer': 'Renderer',
  'electron-gpu': 'GPU',
  'electron-utility': 'Utility',
  server: 'Server',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'opencode',
  'mcp-server': 'MCP',
  git: 'git',
  shell: 'Shell',
  other: 'Other'
}

export function processTypeLabel(type: MonitorProcessType): string {
  return TYPE_LABELS[type] ?? type
}

/**
 * Group kill (signal the whole process group) is appropriate for the agent CLIs
 * and shells that spawn children which would otherwise orphan — mirrors
 * PtyService.destroy(). Plain processes get a single-pid signal.
 */
export function shouldGroupKill(type: MonitorProcessType): boolean {
  return type === 'claude' || type === 'codex' || type === 'opencode' || type === 'shell'
}
