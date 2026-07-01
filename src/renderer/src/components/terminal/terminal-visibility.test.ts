import { describe, expect, it } from 'vitest'
import { computeEffectiveVisible } from './terminal-visibility'

// Regression guard for the ticket-detail typing lag: opening the Dialog raises
// the global ghostty-overlay suppression flag, and the Claude CLI terminal is a
// foreground xterm reparented into that modal. Suppression must not mark it
// hidden — doing so throttles its keystroke echo to the 500ms hidden coalescer
// cadence, which is the delay the user feels. Suppression only hides ghostty.
describe('computeEffectiveVisible', () => {
  it('keeps a visible xterm terminal visible even while suppression is active', () => {
    // The exact ticket-detail-modal case: xterm, on-screen, Dialog open.
    expect(computeEffectiveVisible(true, 'xterm', true)).toBe(true)
  })

  it('leaves a visible xterm terminal visible when nothing is suppressed', () => {
    expect(computeEffectiveVisible(true, 'xterm', false)).toBe(true)
  })

  it('hides a ghostty terminal while suppression is active (NSView punch-through)', () => {
    expect(computeEffectiveVisible(true, 'ghostty', true)).toBe(false)
  })

  it('keeps a visible ghostty terminal visible when nothing is suppressed', () => {
    expect(computeEffectiveVisible(true, 'ghostty', false)).toBe(true)
  })

  it('treats an off-screen terminal as hidden regardless of backend/suppression', () => {
    expect(computeEffectiveVisible(false, 'xterm', false)).toBe(false)
    expect(computeEffectiveVisible(false, 'xterm', true)).toBe(false)
    expect(computeEffectiveVisible(false, 'ghostty', false)).toBe(false)
    expect(computeEffectiveVisible(false, 'ghostty', true)).toBe(false)
  })
})
