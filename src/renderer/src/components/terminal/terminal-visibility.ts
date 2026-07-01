import type { TerminalBackendType } from './backends/types'

export interface EffectiveVisibleInput {
  backendType: TerminalBackendType
  /**
   * App-state visibility hint (active tab / reparented into a modal). This is the
   * ground truth for native ghostty surfaces, but for xterm it is only a
   * pre-measurement fallback used until the IntersectionObserver reports.
   */
  isVisible: boolean
  /**
   * Global flag raised while a modal/menu overlay is open. It exists to hide
   * native ghostty NSViews, which paint on top of everything and punch through
   * DOM z-index. It MUST NOT hide DOM/xterm terminals — doing so is exactly the
   * bug where the Claude CLI reparented into the ticket-detail modal was
   * mislabeled hidden and throttled.
   */
  ghosttyOverlaySuppressed: boolean
  /**
   * IntersectionObserver ground truth for xterm: is the container actually on
   * screen? `null` until the first observation. Ignored for ghostty (a native
   * surface an IntersectionObserver cannot measure).
   */
  onScreen: boolean | null
  /** Whether the app window itself is visible (not minimized / OS-hidden). */
  windowVisible: boolean
}

/**
 * Resolve whether a terminal should be treated as visible — i.e. stream PTY
 * output at full cadence, keep WebGL loaded, and hold full scrollback.
 *
 * Two regimes, split by what can actually be measured:
 *
 * - **ghostty** is a native macOS NSView, not part of the DOM. An
 *   IntersectionObserver can't see it and it ignores z-index / portals, so its
 *   visibility is driven purely by app state and it is hidden whenever an overlay
 *   is suppressing native surfaces.
 * - **xterm** is plain DOM/WebGL living inside the React tree. Its visibility is
 *   driven by real on-screen state from an IntersectionObserver — the container
 *   is `display:none` when its tab/pane is hidden and genuinely on screen when
 *   reparented into the modal — so it is immune to the inferred-flag mislabeling
 *   (active tab / modal target / overlay-suppressed) that throttled a displayed
 *   terminal. Before the observer's first report (`onScreen === null`) it falls
 *   back to the app-state hint so a foreground terminal is never briefly
 *   throttled on mount.
 */
export function computeEffectiveVisible(input: EffectiveVisibleInput): boolean {
  const { backendType, isVisible, ghosttyOverlaySuppressed, onScreen, windowVisible } = input

  if (backendType === 'ghostty') {
    return isVisible && !ghosttyOverlaySuppressed
  }

  if (!windowVisible) return false
  return onScreen ?? isVisible
}
