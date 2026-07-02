/**
 * Persist a renderer-side diagnostic line to the main-process on-disk log.
 *
 * The kanban column-state machine and the session-status store live in the
 * renderer, but their transitions used to be console-only — invisible when
 * diagnosing after the fact why a ticket landed in Review instead of In Progress
 * (the exact gap called out for the "why is this in Review" investigation). This
 * routes those transitions through the preload rendererLog bridge to the same
 * hive-<date>.log the main process writes.
 *
 * Fire-and-forget: a logging failure (bridge absent in tests, IPC hiccup) must
 * never interfere with a state update, so every call is swallowed.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export function logToMain(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>
): void {
  try {
    // window.desktopBridge is undefined under vitest / non-Electron contexts.
    if (typeof window !== 'undefined') {
      window.desktopBridge?.rendererLog?.(level, component, message, data)
    }
  } catch {
    // Never let observability break the caller.
  }
}
