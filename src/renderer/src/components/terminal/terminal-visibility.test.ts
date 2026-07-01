import { describe, expect, it } from 'vitest'
import { computeEffectiveVisible, type EffectiveVisibleInput } from './terminal-visibility'

// Defaults for a foreground xterm with the observer not having reported yet.
const base: EffectiveVisibleInput = {
  backendType: 'xterm',
  isVisible: true,
  ghosttyOverlaySuppressed: false,
  onScreen: null,
  windowVisible: true
}

describe('computeEffectiveVisible — xterm (IntersectionObserver ground truth)', () => {
  // Regression guard for the ticket-detail typing lag: opening the Dialog raises
  // the global ghostty-overlay suppression flag, but the Claude CLI terminal is a
  // foreground xterm genuinely on screen inside that modal. On-screen ground
  // truth must keep it visible — otherwise its keystroke echo is throttled to the
  // 500ms hidden coalescer cadence, which is the delay the user feels.
  it('keeps an on-screen xterm visible even while suppression is active', () => {
    expect(
      computeEffectiveVisible({ ...base, onScreen: true, ghosttyOverlaySuppressed: true })
    ).toBe(true)
  })

  it('throttles an off-screen xterm even when app state still thinks it is visible', () => {
    // The inverse mislabel: app-state hint says visible, but the container is not
    // actually on screen — ground truth wins and it is treated as hidden.
    expect(computeEffectiveVisible({ ...base, isVisible: true, onScreen: false })).toBe(false)
  })

  it('ignores suppression entirely for xterm once on-screen is known', () => {
    expect(
      computeEffectiveVisible({ ...base, onScreen: false, ghosttyOverlaySuppressed: false })
    ).toBe(false)
    expect(
      computeEffectiveVisible({ ...base, onScreen: true, ghosttyOverlaySuppressed: true })
    ).toBe(true)
  })

  it('falls back to the app-state hint before the observer first reports', () => {
    // onScreen === null: a foreground terminal must not be briefly throttled on
    // mount, and a background one must not briefly stream.
    expect(computeEffectiveVisible({ ...base, onScreen: null, isVisible: true })).toBe(true)
    expect(computeEffectiveVisible({ ...base, onScreen: null, isVisible: false })).toBe(false)
  })

  it('treats a minimized window as hidden even for an on-screen xterm', () => {
    expect(computeEffectiveVisible({ ...base, onScreen: true, windowVisible: false })).toBe(false)
  })
})

describe('computeEffectiveVisible — ghostty (app-state, native surface)', () => {
  // Ghostty is a native NSView an IntersectionObserver cannot see, so it stays on
  // the app-state path: hidden while an overlay is suppressing native surfaces.
  it('hides a ghostty terminal while suppression is active (NSView punch-through)', () => {
    expect(
      computeEffectiveVisible({
        ...base,
        backendType: 'ghostty',
        isVisible: true,
        ghosttyOverlaySuppressed: true
      })
    ).toBe(false)
  })

  it('keeps a visible ghostty terminal visible when nothing is suppressed', () => {
    expect(
      computeEffectiveVisible({ ...base, backendType: 'ghostty', isVisible: true })
    ).toBe(true)
  })

  it('hides an inactive ghostty terminal', () => {
    expect(
      computeEffectiveVisible({ ...base, backendType: 'ghostty', isVisible: false })
    ).toBe(false)
  })

  it('ignores the on-screen observer signal for ghostty', () => {
    // Even if some stray observation set onScreen, ghostty must follow app state.
    expect(
      computeEffectiveVisible({
        ...base,
        backendType: 'ghostty',
        isVisible: false,
        onScreen: true
      })
    ).toBe(false)
  })
})
