/**
 * While a terminal is hidden, the server coalesces its PTY output and flushes it
 * across the renderer WebSocket at most this often (ms) instead of once per
 * event-loop tick. A fleet of backgrounded agents each streaming a TUI would
 * otherwise flood the single socket, and the renderer JSON.parses every message
 * on its main thread — starving the *focused* terminal's keystroke echo. Matches
 * the renderer-side HIDDEN_FLUSH_MS so both layers batch on the same cadence.
 */
export const HIDDEN_TERMINAL_FLUSH_MS = 500

/**
 * Hard cap on server-buffered-but-unpublished terminal output. A burst this
 * large flushes immediately regardless of the visibility cadence, so server
 * memory can't grow unbounded behind a hidden terminal's slow flush.
 */
export const MAX_PENDING_TERMINAL_OUTPUT_BYTES = 1_000_000

export interface GhosttyTerminalConfig {
  /** Primary font family (first `font-family` line in the Ghostty config) */
  fontFamily?: string
  /** All `font-family` lines in order: primary first, then fallback fonts */
  fontFamilies?: string[]
  fontSize?: number
  background?: string
  foreground?: string
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorColor?: string
  shell?: string
  scrollbackLimit?: number
  palette?: Record<number, string>
  selectionBackground?: string
  selectionForeground?: string
}
