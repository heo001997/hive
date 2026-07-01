import type { TerminalBackendType } from './backends/types'

/**
 * Resolve whether a terminal should be treated as visible — i.e. stream PTY
 * output at full cadence, keep WebGL loaded, and hold full scrollback.
 *
 * Ghostty-overlay suppression exists to hide native Ghostty surfaces (macOS
 * NSViews) that paint on top of everything and would punch through a modal or
 * menu — they ignore DOM z-index and portals. xterm is plain DOM/WebGL: it sits
 * inside the React tree, respects z-index, and can be portaled directly into the
 * modal, so suppression must NOT hide it. Marking a foreground xterm terminal
 * hidden — e.g. the Claude CLI reparented into the ticket-detail modal, where
 * opening the Dialog itself raises the global suppression flag — mis-classifies
 * it as backgrounded: the server throttles its output (including keystroke echo)
 * to the hidden coalescer cadence (HIDDEN_TERMINAL_FLUSH_MS = 500ms), drops its
 * WebGL, and trims scrollback, which is exactly the "typing feels delayed" lag
 * inside the modal. Only ghostty backends are hidden by suppression.
 */
export function computeEffectiveVisible(
  isVisible: boolean,
  backendType: TerminalBackendType,
  ghosttyOverlaySuppressed: boolean
): boolean {
  return isVisible && (backendType !== 'ghostty' || !ghosttyOverlaySuppressed)
}
