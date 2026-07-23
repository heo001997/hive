// E2E: ensure-hive-ticket-in-correct-co — Human Require CLI lifecycle (non-blocking transitions)
//
// File 2 of 5. CLI (`claude-cli:status`) lifecycle routing that does NOT block on the user:
//   TC04 working-resume (human_required → In Progress), TC05 tool-activity (stays In Progress),
//   TC06 sub-agent proxy (stays In Progress), TC13 clean Stop (→ Review), TC14 quiescence
//   (a Human-Require ticket stays Human Require — promote-guard).
//
// Triggers use the sanctioned /api/events/publish injection seam (publishEvent → real
// eventBus → WS → useClaudeCliStatusListener → useWorktreeStatusStore → kanban sync bridge).
// There is no real Claude CLI process in browser E2E, so the status push is the faithful
// analog of "the agent emitted a status" (precondition 0.4, F3). All other actions are UI.
//
// Cards are seeded mode:'build': the session_completed → Review promotion
// (promoteToReviewWhenQuiescent) only fires for build-mode tickets, and a blocked build
// ticket is the realistic subject of these transitions.

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
  { key: 'tc04', title: 'HUMANREQ TC04 working sentinel', column: 'human_required' },
  { key: 'tc05', title: 'HUMANREQ TC05 toolactivity sentinel', column: 'in_progress' },
  { key: 'tc06', title: 'HUMANREQ TC06 subagent sentinel', column: 'in_progress' },
  { key: 'tc13', title: 'HUMANREQ TC13 cleanstop sentinel', column: 'in_progress' },
  { key: 'tc14', title: 'HUMANREQ TC14 resting sentinel', column: 'human_required' }
] as const

// current_session_id has a FOREIGN KEY to sessions(id), so each card needs a REAL session
// row. db.session.create generates the id — capture it here and publish claude-cli:status
// events against it. Keyed by the CARDS key.
const SIDS: Record<string, string> = {}

let app: HiveApp

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  // Suppress the async agent-picker onboarding dialog (multi-agent host).
  const settings = await app.rpcCall('db.setting.set', {
    key: 'app_settings',
    value: JSON.stringify({ initialSetupComplete: true, tipsEnabled: false })
  })
  expect(settings.ok, JSON.stringify(settings)).toBe(true)

  const repo = makeTempGitRepo('humanreq-cli-lifecycle')
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
      column: c.column,
      mode: 'build',
      current_session_id: session.value!.id
    })
    expect(t.ok, JSON.stringify(t)).toBe(true)
  }
})

test.afterAll(async () => {
  await app?.stop()
})

// ── Shared humanlike helpers (see File 1 for rationale) ────────────────────
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

// Screenshot with the target card red-outlined (§11) — sibling context frames share the
// same board state, so highlighting the TC's distinctive card makes each byte-distinct.
const shotCard = async (page: Page, name: string, title: string): Promise<void> => {
  const card = page.locator('[data-testid^="kanban-ticket-"]').filter({ hasText: title }).first()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card
    .evaluate((el) => {
      el.style.outline = '3px solid red'
      el.style.outlineOffset = '4px'
      el.style.boxShadow = '0 0 10px 3px rgba(255,0,0,0.5)'
    })
    .catch(() => undefined)
  await screenshot(page, name, { fullPage: true })
  await card
    .evaluate((el) => {
      el.style.outline = ''
      el.style.outlineOffset = ''
      el.style.boxShadow = ''
    })
    .catch(() => undefined)
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — TC04: a `working` signal moves a Human-Require ticket back to In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC04 — working resume moves the card from Human Require to In Progress', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC04 working sentinel'

  // 4.1 context
  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc04-4.1-context', TITLE)

  // 4.2 start column: Human Require
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc04-4.2-start-hr', { fullPage: true })

  // 4.3 BEFORE baseline
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc04-4.3-before', { fullPage: true })

  // 4.4 trigger + AFTER: working → In Progress
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', { sessionId: SIDS.tc04, status: 'working' })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc04-4.4-after-inprogress', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — TC05: tool activity (`working`) keeps an In-Progress ticket In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC05 — tool-activity working keeps the card In Progress', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC05 toolactivity sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc05-5.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc05-5.2-start-inprogress', { fullPage: true })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc05-5.3-before', { fullPage: true })

  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc05,
    status: 'working',
    metadata: { hookEventName: 'PostToolUse', toolName: 'Bash' }
  })
  // Negative assertion: give the event a real chance to (wrongly) move the card, then
  // confirm it stayed. Wait on the card's own visibility in In Progress first.
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc05-5.4-after-stays', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6 — TC06: sustained sub-agent `working` keeps the ticket In Progress, never promoted
// ═══════════════════════════════════════════════════════════════════════════
test('TC06 — sub-agent working keeps the card In Progress, never auto-promoted', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC06 subagent sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc06-6.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc06-6.2-start-inprogress', { fullPage: true })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc06-6.3-before', { fullPage: true })

  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc06,
    status: 'working',
    metadata: { reason: 'subagent_running' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc06-6.4-after-stays', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — TC13: a clean Stop promotes the ticket to Review
// ═══════════════════════════════════════════════════════════════════════════
test('TC13 — clean Stop promotes the card to Review', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC13 cleanstop sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc13-7.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc13-7.2-start-inprogress', { fullPage: true })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc13-7.3-before', { fullPage: true })

  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  // Clean Stop (build mode, no StopFailure) → session_completed → promoteToReviewWhenQuiescent.
  // The seeded session has no live PTY, so the frozen-confirm resolves quickly (db fingerprint
  // stable) and the card promotes to Review.
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc13,
    status: 'completed',
    metadata: { hookEventName: 'Stop' }
  })
  await expect(col(page, 'review').getByText(TITLE)).toBeVisible({ timeout: 20_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  // Widen the viewport so the Review column (off-screen at 1280px) is in-frame for the
  // evidence capture, then scroll the board to its left origin.
  await page.setViewportSize({ width: 1920, height: 900 })
  await page
    .getByTestId('kanban-board')
    .evaluate((el) => {
      el.scrollLeft = 0
    })
    .catch(() => undefined)
  await expect(col(page, 'review').getByText(TITLE)).toBeVisible()
  await screenshot(page, 'tc13-7.4-after-review', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 8 — TC14: a `completed`/quiescence signal does NOT sweep a Human-Require ticket to Review
// ═══════════════════════════════════════════════════════════════════════════
test('TC14 — a quiet Human-Require ticket stays in Human Require on completed', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC14 resting sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc14-8.1-context', TITLE)

  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc14-8.2-start-hr', { fullPage: true })

  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc14-8.3-before', { fullPage: true })

  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc14,
    status: 'completed',
    metadata: { hookEventName: 'Stop' }
  })
  // Negative: the promote-guard must keep it in Human Require. Assert it is still there
  // and never appeared in Review.
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc14-8.4-after-stays-hr', { fullPage: true })
})
