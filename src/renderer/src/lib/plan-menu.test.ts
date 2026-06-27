import { describe, expect, it } from 'vitest'
import {
  buildSelectionKeystrokes,
  findMatchingOption,
  parsePlanMenu,
  type ParsedPlanMenu
} from './plan-menu'

const KEY_DOWN = '\x1b[B'
const KEY_UP = '\x1b[A'
const KEY_ENTER = '\r'

// A representative ExitPlanMode menu as it lands in the xterm buffer: a header
// line, a blank, then the numbered options with `❯` on the default selection.
const MENU_LINES = [
  '  Claude has finished planning and is ready to execute.',
  '  Would you like to proceed?',
  '',
  '❯ 1. Yes, and auto-accept edits',
  '  2. Yes, and manually approve edits',
  '  3. No, keep planning',
  ''
]

describe('parsePlanMenu', () => {
  it('parses the options, labels, and cursor position', () => {
    const menu = parsePlanMenu(MENU_LINES)
    expect(menu).not.toBeNull()
    expect(menu?.options).toEqual([
      { number: 1, text: 'Yes, and auto-accept edits', hasCursor: true },
      { number: 2, text: 'Yes, and manually approve edits', hasCursor: false },
      { number: 3, text: 'No, keep planning', hasCursor: false }
    ])
    expect(menu?.cursorIndex).toBe(0)
  })

  it('tracks the cursor when it is not on the first option', () => {
    const menu = parsePlanMenu([
      '  Would you like to proceed?',
      '  1. Yes, and auto-accept edits',
      '❯ 2. Yes, and manually approve edits',
      '  3. No, keep planning'
    ])
    expect(menu?.cursorIndex).toBe(1)
    expect(menu?.options[1].hasCursor).toBe(true)
  })

  it('handles a larger N-option menu generically', () => {
    const menu = parsePlanMenu([
      '  Would you like to proceed?',
      '  1. Yes, and bypass permissions for this session',
      '❯ 2. Yes, and manually approve edits',
      '  3. Yes, and clear context first',
      '  4. No, refine the plan',
      '  5. No, keep planning'
    ])
    expect(menu?.options).toHaveLength(5)
    expect(menu?.cursorIndex).toBe(1)
    expect(menu?.options[4].text).toBe('No, keep planning')
  })

  it('tolerates a boxed/gutter rendering', () => {
    const menu = parsePlanMenu([
      '│ Would you like to proceed?',
      '│ ❯ 1. Yes, and auto-accept edits',
      '│   2. No, keep planning'
    ])
    expect(menu?.options).toHaveLength(2)
    expect(menu?.cursorIndex).toBe(0)
    expect(menu?.options[0].text).toBe('Yes, and auto-accept edits')
  })

  it('parses a cursor-less menu, defaulting the cursor to option 1', () => {
    // The real Claude Code prompt often highlights via color, not a glyph, so
    // translateToString yields no ❯. We must still parse and assume option 1.
    const menu = parsePlanMenu(['  1. Yes, and auto-accept edits', '  2. No, keep planning'])
    expect(menu?.options).toHaveLength(2)
    expect(menu?.cursorIndex).toBe(0)
  })

  it('parses the real ExitPlanMode menu (no glyph, descriptive labels, trailing hint)', () => {
    const menu = parsePlanMenu([
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '',
      '  1. Yes, clear context (18% used) and bypass permissions',
      '  2. Yes, and bypass permissions',
      '  3. Yes, manually approve edits',
      '  4. No, refine with Ultraplan on Claude Code on the web',
      '  5. Tell Claude what to change',
      '  shift+tab to approve with this feedback'
    ])
    expect(menu?.options).toHaveLength(5)
    expect(menu?.cursorIndex).toBe(0)
    expect(menu?.options[2].text).toBe('Yes, manually approve edits')
    // The non-numbered hint line is excluded.
    expect(menu?.options.some((o) => o.text.includes('shift+tab'))).toBe(false)
    // A specific needle reaches exactly one option.
    expect(findMatchingOption(menu!.options, 'manually approve')?.number).toBe(3)
  })

  it('requires at least two sequential options (ignores a lone numbered line)', () => {
    expect(parsePlanMenu(['  1. This is a single numbered item in prose'])).toBeNull()
  })

  it('returns null when there is no menu at all', () => {
    expect(parsePlanMenu(['just some plan text', '', 'more text'])).toBeNull()
  })

  it('prefers the live menu over a stale one earlier in scrollback', () => {
    const menu = parsePlanMenu([
      '❯ 1. Stale option from a previous prompt',
      '  2. Stale second option',
      '',
      'lots of intervening output',
      '',
      '  1. Yes, and auto-accept edits',
      '❯ 2. Yes, and manually approve edits',
      '  3. No, keep planning'
    ])
    expect(menu?.options[menu.cursorIndex].text).toBe('Yes, and manually approve edits')
    expect(menu?.options).toHaveLength(3)
  })
})

describe('findMatchingOption', () => {
  const menu = parsePlanMenu(MENU_LINES) as ParsedPlanMenu

  it('matches case-insensitively on substring', () => {
    expect(findMatchingOption(menu.options, 'manually approve')?.number).toBe(2)
    expect(findMatchingOption(menu.options, 'AUTO-ACCEPT')?.number).toBe(1)
    expect(findMatchingOption(menu.options, 'keep planning')?.number).toBe(3)
  })

  it('trims the needle', () => {
    expect(findMatchingOption(menu.options, '  auto-accept  ')?.number).toBe(1)
  })

  it('returns null for an empty needle', () => {
    expect(findMatchingOption(menu.options, '')).toBeNull()
    expect(findMatchingOption(menu.options, '   ')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(findMatchingOption(menu.options, 'nonexistent option')).toBeNull()
  })
})

describe('buildSelectionKeystrokes', () => {
  const menu = parsePlanMenu(MENU_LINES) as ParsedPlanMenu

  it('just confirms when the target is already under the cursor', () => {
    const target = menu.options[0]
    expect(buildSelectionKeystrokes(menu, target)).toBe(KEY_ENTER)
  })

  it('moves down then confirms', () => {
    expect(buildSelectionKeystrokes(menu, menu.options[2])).toBe(KEY_DOWN + KEY_DOWN + KEY_ENTER)
  })

  it('moves up then confirms', () => {
    const cursorOnLast: ParsedPlanMenu = { options: menu.options, cursorIndex: 2 }
    expect(buildSelectionKeystrokes(cursorOnLast, menu.options[0])).toBe(
      KEY_UP + KEY_UP + KEY_ENTER
    )
  })

  it('returns empty string when the target is not in the menu', () => {
    expect(buildSelectionKeystrokes(menu, { number: 99, text: 'ghost', hasCursor: false })).toBe('')
  })
})
