// E2E: ensure-hive-ticket-in-correct-co — Human Require CLI blocked-on-user routing
//
// File 3 of 5. CLI (`claude-cli:status`) blocked-on-user routing (F3):
//   TC07 AskUserQuestion (→ HR, answered → In Progress), TC08 permission (round-trip),
//   TC09 MCP elicitation (round-trip), TC12 StopFailure (→ HR, NOT Review),
//   TC18 the needs-you "Questions" badge follows the Human Require column.
//
// Bridge: `answering`/`permission` → session_human_required → Human Require; `working` →
// session_working → In Progress; StopFailure → session_error → Human Require (Review
// suppressed). session_human_required only moves build-mode In-Progress tickets, so all
// cards are seeded mode:'build' with a real session (current_session_id has a FK).
// Triggers = the sanctioned /api/events/publish injection seam (precondition 0.4, F3).

import { test, expect, type Page } from '@playwright/test'
import {
  launchHiveBrowserApp,
  makeTempGitRepo,
  screenshot,
  publishEvent,
  type HiveApp
} from './support/harness'

test.describe.configure({ mode: 'serial' })

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

const PROJECT = 'e2e-humanreq-project'
const CARDS = [
  { key: 'tc07', title: 'HUMANREQ TC07 askquestion sentinel' },
  { key: 'tc08', title: 'HUMANREQ TC08 permission sentinel' },
  { key: 'tc09', title: 'HUMANREQ TC09 elicitation sentinel' },
  { key: 'tc12', title: 'HUMANREQ TC12 stopfailure sentinel' },
  { key: 'tc18', title: 'HUMANREQ TC18 badge sentinel' }
] as const

const SIDS: Record<string, string> = {}

let app: HiveApp

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  const settings = await app.rpcCall('db.setting.set', {
    key: 'app_settings',
    value: JSON.stringify({ initialSetupComplete: true, tipsEnabled: false })
  })
  expect(settings.ok, JSON.stringify(settings)).toBe(true)

  const repo = makeTempGitRepo('humanreq-cli-blocked')
  const created = await app.rpcCall<ProjectRow>('db.project.create', { name: PROJECT, path: repo })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const projectId = created.value!.id

  for (const c of CARDS) {
    const session = await app.rpcCall<{ id: string }>('db.session.create', {
      project_id: projectId,
      worktree_id: null,
      agent_sdk: 'claude-code',
      mode: 'build'
    })
    expect(session.ok, JSON.stringify(session)).toBe(true)
    SIDS[c.key] = session.value!.id

    const t = await app.rpcCall('kanban.ticket.create', {
      project_id: projectId,
      title: c.title,
      column: 'in_progress',
      mode: 'build',
      current_session_id: session.value!.id
    })
    expect(t.ok, JSON.stringify(t)).toBe(true)
  }
})

test.afterAll(async () => {
  await app?.stop()
})

// ── Shared helpers (see File 1/2) ──────────────────────────────────────────
const clearAgentPicker = async (page: Page): Promise<void> => {
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  for (let i = 0; i < 12; i++) {
    if ((await overlay.count()) === 0) return
    const claude = page.getByText('Claude Code', { exact: true }).first()
    if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
    await expect(overlay).toHaveCount(0, { timeout: 2_000 }).catch(() => undefined)
  }
}

const navToBoard = async (page: Page): Promise<void> => {
  await page.goto(app.appUrl)
  await page.waitForLoadState('domcontentloaded')
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
      timeout: 25_000
    })
    .catch(() => undefined)
  await clearAgentPicker(page)
  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-testid^="project-item-"]').first().click()
  await clearAgentPicker(page)
  await page.evaluate(() => {
    const w = window as unknown as {
      __hive_useSessionStore__?: { getState(): { setActiveSession(id: string): void } }
    }
    w.__hive_useSessionStore__?.getState().setActiveSession('__board__')
  })
  await clearAgentPicker(page)
  await expect(page.getByTestId('kanban-column-in_progress')).toBeVisible({ timeout: 15_000 })
}

const col = (page: Page, c: string) => page.getByTestId(`kanban-column-${c}`)

// framer-motion slides a moving card between columns; poll until the card box is fully
// within the target column horizontally so a screenshot captures the settled state
// (same helper as the plan/sdk specs — evidence framing only, no assertion change).
const settledInColumn = async (page: Page, colName: string, title: string): Promise<void> => {
  await expect
    .poll(
      async () => {
        const cardBox = await col(page, colName).getByText(title).boundingBox()
        const colBox = await col(page, colName).boundingBox()
        if (!cardBox || !colBox) return false
        return cardBox.x >= colBox.x - 2 && cardBox.x + cardBox.width <= colBox.x + colBox.width + 2
      },
      { timeout: 10_000 }
    )
    .toBe(true)
}

// A round-trip: card starts In Progress → the blocking event routes it to Human Require →
// a `working` resume returns it to In Progress.
const runRoundTrip = async (
  page: Page,
  opts: {
    title: string
    sid: string
    enter: { status: string; metadata: Record<string, unknown> }
    tc: string
    phase: number
  }
): Promise<void> => {
  const { title, sid, enter, tc, phase } = opts
  const p = `${tc}-${phase}`

  // N.1 context
  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await screenshot(page, `${p}.1-context`, { fullPage: true })

  // N.2 start In Progress
  await expect(col(page, 'in_progress').getByText(title)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, `${p}.2-start-inprogress`, { fullPage: true })

  // N.3 enter → Human Require
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', { sessionId: sid, status: enter.status, metadata: enter.metadata })
  await expect(col(page, 'human_required').getByText(title)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(title)).toHaveCount(0)
  await screenshot(page, `${p}.3-enter-hr`, { fullPage: true })

  // N.4 resume (working) → In Progress
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', { sessionId: sid, status: 'working' })
  await expect(col(page, 'in_progress').getByText(title)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(title)).toHaveCount(0)
  await screenshot(page, `${p}.4-resume-inprogress`, { fullPage: true })
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 9 — TC07: AskUserQuestion → Human Require; answered → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC07 — AskUserQuestion routes to Human Require and back on resume', async ({ page }) => {
  test.setTimeout(120_000)
  await runRoundTrip(page, {
    title: 'HUMANREQ TC07 askquestion sentinel',
    sid: SIDS.tc07,
    enter: { status: 'answering', metadata: { hookEventName: 'PreToolUse', toolName: 'AskUserQuestion' } },
    tc: 'tc07', phase: 9
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 10 — TC08: permission → Human Require; replied → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC08 — permission request routes to Human Require and back on resume', async ({ page }) => {
  test.setTimeout(120_000)
  await runRoundTrip(page, {
    title: 'HUMANREQ TC08 permission sentinel',
    sid: SIDS.tc08,
    enter: { status: 'permission', metadata: { hookEventName: 'PreToolUse' } },
    tc: 'tc08', phase: 10
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 11 — TC09: MCP elicitation → Human Require; resolved → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC09 — MCP elicitation routes to Human Require and back on resume', async ({ page }) => {
  test.setTimeout(120_000)
  await runRoundTrip(page, {
    title: 'HUMANREQ TC09 elicitation sentinel',
    sid: SIDS.tc09,
    enter: { status: 'permission', metadata: { hookEventName: 'Elicitation' } },
    tc: 'tc09', phase: 11
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 12 — TC12: StopFailure → Human Require, NOT Review
// ═══════════════════════════════════════════════════════════════════════════
test('TC12 — an errored turn (StopFailure) routes to Human Require, not Review', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC12 stopfailure sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await screenshot(page, 'tc12-12.1-context', { fullPage: true })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc12-12.2-start-inprogress', { fullPage: true })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc12-12.3-before', { fullPage: true })

  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  // StopFailure → listener fires session_error (→ Human Require) + sets 'unread' (no
  // session_completed → no Review promotion).
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc12,
    status: 'completed',
    metadata: { hookEventName: 'StopFailure' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc12-12.4-after-hr', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 13 — TC18: the needs-you "Questions" badge follows the Human Require column
// ═══════════════════════════════════════════════════════════════════════════
test('TC18 — the Questions badge appears only once the card is in Human Require', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC18 badge sentinel'
  const cardBy = (p: Page) =>
    p.locator('[data-testid^="kanban-ticket-"]').filter({ hasText: TITLE })

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await screenshot(page, 'tc18-13.1-context', { fullPage: true })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  // Outline THIS TC's card so the start-in-progress frame is byte-distinct from the other
  // TCs' identical seeded boards (SK-1) and the reviewer's eye lands on the TC18 card; reset
  // immediately so the negative (13.3) and positive (13.4) frames stay clean.
  const tc18Start = cardBy(page).first()
  await tc18Start.evaluate((el: HTMLElement) => {
    el.style.outline = '3px solid #ef4444'
    el.style.outlineOffset = '2px'
  })
  await screenshot(page, 'tc18-13.2-start-inprogress', { fullPage: true })
  await tc18Start.evaluate((el: HTMLElement) => {
    el.style.outline = ''
    el.style.outlineOffset = ''
  })

  // 13.3 negative: no Questions badge while in In Progress
  await expect(cardBy(page)).toBeVisible()
  await expect(cardBy(page).getByTestId('kanban-ticket-completion-questions')).toHaveCount(0)
  await screenshot(page, 'tc18-13.3-no-badge-before', { fullPage: true })

  // 13.4 positive: route to Human Require → the needs-you "Questions" badge should render.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc18,
    status: 'answering',
    metadata: { hookEventName: 'PreToolUse', toolName: 'AskUserQuestion' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  // Let the framer-motion slide land the card fully inside Human Require before capture,
  // so the evidence frame shows the settled card + badge (not a mid-flight transform).
  await settledInColumn(page, 'human_required', TITLE)
  // Capture the settled state so the evidence frame documents the actual rendered card:
  // the needs-you "Questions" badge now renders on the Human-Require card.
  await screenshot(page, 'tc18-13.4-badge-after', { fullPage: true })
  // EXPECTED (feature contract + KanbanTicketCard.tsx:1181 + its comment "the column itself
  // means needs-you, so the badge covers every case there"): the Questions badge renders for
  // ANY human_required card. This assertion passes now that the badges-row gate at
  // KanbanTicketCard.tsx includes `ticket.column === 'human_required'` — a Human-Require card
  // with no worktree / note / error-status / PR / other trigger still renders the badge row.
  // (This assertion caught the original bug where that column term was omitted from the gate.)
  await expect(cardBy(page).getByTestId('kanban-ticket-completion-questions')).toBeVisible()
})
