import { useEffect, useState, type RefObject } from 'react'

export interface TerminalOnScreen {
  /**
   * Whether the observed container is actually on screen, per an
   * IntersectionObserver. `null` until the first observation (or while
   * detection is disabled) so callers can fall back to an app-state hint.
   */
  onScreen: boolean | null
  /** Whether the app window itself is visible (not minimized / OS-hidden). */
  windowVisible: boolean
}

/**
 * Ground-truth on-screen detection for a terminal container. Instead of
 * inferring visibility from scattered app-state flags (active tab, modal target,
 * overlay-suppressed) — which mislabeled a displayed terminal as hidden and
 * throttled its PTY output — this measures the DOM directly:
 *
 * - An IntersectionObserver reports whether the container intersects the
 *   viewport. A hidden tab/pane is `display:none` (never intersects); a terminal
 *   reparented into a visible modal genuinely intersects. Because covered
 *   terminals are always `display:none` here (never merely z-covered), plain
 *   intersection is a complete signal — no occlusion tracking needed.
 * - `document.visibilityState` reports whether the whole window is visible, so a
 *   minimized app throttles every terminal.
 *
 * `onScreen` starts `null` and stays `null` while `enabled` is false (native
 * ghostty surfaces can't be observed this way — the caller drives those from app
 * state). Once the observer fires, `onScreen` is the source of truth.
 */
export function useTerminalOnScreen(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean
): TerminalOnScreen {
  const [onScreen, setOnScreen] = useState<boolean | null>(null)
  const [windowVisible, setWindowVisible] = useState(
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  )

  useEffect(() => {
    if (!enabled) {
      setOnScreen(null)
      return
    }
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      // No element yet, or no IntersectionObserver (test/SSR): assume on screen
      // so a terminal we cannot measure is never falsely throttled.
      setOnScreen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setOnScreen(entry.isIntersecting && entry.intersectionRatio > 0)
      },
      { threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled, ref])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const handle = (): void => setWindowVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', handle)
    return () => document.removeEventListener('visibilitychange', handle)
  }, [])

  return { onScreen, windowVisible }
}
