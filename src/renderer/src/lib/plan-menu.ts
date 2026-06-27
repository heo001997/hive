/**
 * Pure parser/matcher for the Claude Code CLI plan-mode (ExitPlanMode) approval
 * menu as it is rendered into the xterm buffer.
 *
 * When a `claude-code-cli` session finishes planning, the real `claude` binary
 * prints a select prompt with N behaviorally-distinct options (auto-accept vs
 * manually approve vs keep planning, etc.) and forces a keyboard selection.
 * The hook server can only answer allow/deny, so it cannot express *which*
 * option to pick. To honor the user's "auto-approve plan" setting we instead
 * read the rendered menu off the terminal buffer, find the option whose text
 * matches the configured string, and synthesize the arrow+Enter keystrokes that
 * land on it.
 *
 * This module is intentionally free of any DOM/terminal/React dependency so the
 * parsing and keystroke math can be unit-tested in isolation.
 */

export interface PlanMenuOption {
  /** The 1-based number printed before the option (e.g. `2` in "2. Yes"). */
  number: number
  /** The option label with the leading number/cursor stripped. */
  text: string
  /** Whether this line carried the `❯` cursor marker when read. */
  hasCursor: boolean
}

export interface ParsedPlanMenu {
  options: PlanMenuOption[]
  /** Index into `options` of the currently-highlighted (❯) option. */
  cursorIndex: number
}

/**
 * Matches a single menu option line. Tolerates a leading gutter (box borders /
 * indentation) and an optional `❯` cursor marker, then requires `<n>. <label>`.
 * The label capture is `.*\S` so trailing whitespace is dropped.
 *
 * The cursor marker is optional on purpose: the real Claude Code select prompt
 * highlights the active row with inverse video / color rather than a literal
 * glyph in many renderings, so `translateToString` yields no `❯`. We therefore
 * anchor the menu on the numbered block itself and only *use* `❯` when present.
 */
const OPTION_RE = /^[\s│┃|]*(❯|>)?\s*(\d+)\.\s+(.*\S)\s*$/

interface Candidate {
  lineIdx: number
  number: number
  text: string
  hasCursor: boolean
}

/** Down/up arrow + Enter as the terminal sees them. */
const KEY_DOWN = '\x1b[B'
const KEY_UP = '\x1b[A'
const KEY_ENTER = '\r'

/**
 * Parse the visible terminal lines into the active plan menu, or `null` if no
 * live menu is present yet.
 *
 * Strategy: collect every numbered-option line, then group them into runs that
 * are near-contiguous (≤2 lines apart, to tolerate the odd blank row) AND whose
 * numbers increase by one starting at `1`. Such a run is the select prompt. We
 * pick the run that carries a `❯`/`>` cursor if any does (most reliable), else
 * the LAST qualifying run — the live prompt always sits at the bottom of the
 * viewport, below the plan text. The cursor defaults to option 1, which is what
 * Claude Code highlights on first render (and we act on first render).
 */
export function parsePlanMenu(lines: string[]): ParsedPlanMenu | null {
  const candidates: Candidate[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = OPTION_RE.exec(lines[i])
    if (match) {
      candidates.push({
        lineIdx: i,
        number: Number(match[2]),
        text: match[3].trim(),
        hasCursor: Boolean(match[1])
      })
    }
  }
  if (candidates.length === 0) return null

  // Split the candidates into near-contiguous runs of incrementing numbers.
  const runs: Candidate[][] = []
  let run: Candidate[] = []
  for (const candidate of candidates) {
    const prev = run[run.length - 1]
    const continues =
      prev && candidate.lineIdx - prev.lineIdx <= 2 && candidate.number === prev.number + 1
    if (run.length === 0 || continues) {
      run.push(candidate)
    } else {
      runs.push(run)
      run = [candidate]
    }
  }
  runs.push(run)

  // Keep only runs that look like a real menu (start at 1, ≥2 options). Prefer
  // the last run carrying a `❯`/`>` cursor; else the last qualifying run — the
  // live prompt always sits at the bottom of the viewport.
  const qualifying = runs.filter((r) => r.length >= 2 && r[0].number === 1)
  if (qualifying.length === 0) return null
  const lastCursorRun = [...qualifying].reverse().find((r) => r.some((c) => c.hasCursor))
  const chosen = lastCursorRun ?? qualifying[qualifying.length - 1]

  const options: PlanMenuOption[] = chosen.map((c) => ({
    number: c.number,
    text: c.text,
    hasCursor: c.hasCursor
  }))
  const markedIndex = options.findIndex((o) => o.hasCursor)
  return { options, cursorIndex: markedIndex === -1 ? 0 : markedIndex }
}

/**
 * Find the option whose label contains `matchText` (case-insensitive). Returns
 * `null` for an empty needle or when nothing matches — callers should then
 * leave the menu for the user to resolve manually.
 */
export function findMatchingOption(
  options: PlanMenuOption[],
  matchText: string
): PlanMenuOption | null {
  const needle = matchText.trim().toLowerCase()
  if (!needle) return null
  return options.find((option) => option.text.toLowerCase().includes(needle)) ?? null
}

/**
 * Build the keystrokes that move the cursor from its current position to
 * `target` and confirm. Movement is linear within the visible options (no
 * wrap), computed from the `❯` cursor we read off-screen, so it lands
 * deterministically regardless of which option was highlighted by default.
 * Returns `''` if the target isn't in the menu.
 */
export function buildSelectionKeystrokes(menu: ParsedPlanMenu, target: PlanMenuOption): string {
  const targetIndex = menu.options.findIndex((option) => option.number === target.number)
  if (targetIndex === -1) return ''
  const delta = targetIndex - menu.cursorIndex
  if (delta === 0) return KEY_ENTER
  const arrow = delta > 0 ? KEY_DOWN : KEY_UP
  return arrow.repeat(Math.abs(delta)) + KEY_ENTER
}
