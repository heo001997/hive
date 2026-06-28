import type { ServerEvent } from '@shared/rpc/protocol'
import {
  SYSTEM_MONITOR_SNAPSHOT_CHANNEL,
  SYSTEM_MONITOR_ALERT_CHANNEL,
  type MonitorSnapshot,
  type MonitorAlert
} from '@shared/system-monitor-events'
import { getRendererRpcClient } from './rpc-client'

export type { MonitorSnapshot, MonitorAlert } from '@shared/system-monitor-events'

export const monitorApi = {
  /** Latest snapshot (host + process tree). */
  getSnapshot: async (): Promise<MonitorSnapshot> =>
    getRendererRpcClient().request<MonitorSnapshot>('systemMonitorOps.getSnapshot', {}),

  /** In-memory snapshot history (for instant sparkline fill on open). */
  getHistory: async (): Promise<MonitorSnapshot[]> =>
    getRendererRpcClient().request<MonitorSnapshot[]>('systemMonitorOps.getHistory', {}),

  /** Recent alerts kept in the server-side ring buffer. */
  getAlerts: async (): Promise<MonitorAlert[]> =>
    getRendererRpcClient().request<MonitorAlert[]>('systemMonitorOps.getAlerts', {}),

  /** Panel open/close → fast (2s) vs background (15s) sampling cadence. */
  setActive: async (active: boolean): Promise<void> =>
    getRendererRpcClient().request<void>('systemMonitorOps.setActive', { active }),

  /** Enable/disable background sampling (alerts + history) when panel is closed. */
  setEnabled: async (enabled: boolean): Promise<void> =>
    getRendererRpcClient().request<void>('systemMonitorOps.setEnabled', { enabled }),

  /** Signal a process (optionally its whole group). */
  killProcess: async (pid: number, group = false): Promise<void> =>
    getRendererRpcClient().request<void>('systemMonitorOps.killProcess', { pid, group }),

  /** Force-reap MCP servers orphaned to PID 1. Returns the count signalled. */
  cleanupOrphans: async (): Promise<number> =>
    getRendererRpcClient().request<number>('systemMonitorOps.cleanupOrphans', {}),

  subscribeSnapshots: (callback: (snapshot: MonitorSnapshot) => void): (() => void) =>
    getRendererRpcClient().subscribe(SYSTEM_MONITOR_SNAPSHOT_CHANNEL, (event: ServerEvent) => {
      callback(event.payload as MonitorSnapshot)
    }),

  subscribeAlerts: (callback: (alert: MonitorAlert) => void): (() => void) =>
    getRendererRpcClient().subscribe(SYSTEM_MONITOR_ALERT_CHANNEL, (event: ServerEvent) => {
      callback(event.payload as MonitorAlert)
    })
}
