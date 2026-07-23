// E2E: ensure-hive-ticket-in-correct-co — Human Require CLI plan-mode routing
//
// File 4 of 5. CLI (`claude-cli:status`) plan-mode routing (F3):
//   TC10 plan approve round-trip: plan_ready → Human Require; approve (PostToolUse
//        ExitPlanMode → implement/working) → In Progress.
//   TC11 plan followup round-trip: plan_ready → Human Require; revise/reject
//        (UserPromptSubmit while plan_ready → plan_followup) → In Progress.
//
// Cards seeded mode:'plan' (isPlanLike): syncTicketWithSession's plan_ready case only
// routes plan-like tickets to Human Require. Sessions are real (current_session_id FK).
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
  { key: 'tc10', title: 'HUMANREQ TC10 planready sentinel' },
  { key: 'tc11', title: 'HUMANREQ TC11 planfollowup sentinel' }
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

  const repo = makeTempGitRepo('humanreq-cli-plan')
  const created = await app.rpcCall<ProjectRow>('db.project.create', { name: PROJECT, path: repo })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const projectId = created.value!.id

  for (const c of CARDS) {
    const session = await app.rpcCall<{ id: string }>('db.session.create', {
      project_id: projectId,
      worktree_id: null,
      agent_sdk: 'claude-code',
      mode: 'plan'
    })
    expect(session.ok, JSON.stringify(session)).toBe(true)
    SIDS[c.key] = session.value!.id

    const t = await app.rpcCall('kanban.ticket.create', {
      project_id: projectId,
      title: c.title,
      column: 'in_progress',
      mode: 'plan',
      current_session_id: session.value!.id
    })
    expect(t.ok, JSON.stringify(t)).toBe(true)
  }
})

test.afterAll(async () => {
  await app?.stop()
})

// ── Shared helpers (see File 1/2/3) ────────────────────────────────────────
const clearAgentPicker = async (page: Page): Promise<void> => {
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  for (let i = 0; i < 12; i++) {
    if ((await overlay.count()) === 0) return
    const claude = page.getByText('Claude Code', { exact: true }).first()
    if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
    await expect(overlay).toHaveCount(0, { timeout: 2_000 }).catch(() => undefined)
  }
}

// The "Hatch your first pet" (and other) coach-mark tips mount asynchronously and can
// win a race against the seeded tipsEnabled:false (the tip is requested before settings
// finish loading). Clicking "Don't show tips" calls disableAllTips → durably sets
// tipsEnabled:false for the session, so one dismissal clears every future tip. Poll a
// bounded window for the tip to appear, then dismiss it (event-driven, no fixed sleep).
const dismissTips = async (page: Page): Promise<void> => {
  const dontShow = page.getByRole('button', { name: "Don't show tips" })
  for (let i = 0; i < 6; i++) {
    if (await dontShow.isVisible().catch(() => false)) {
      await dontShow.click().catch(() => undefined)
      await expect(dontShow).toBeHidden({ timeout: 2_000 }).catch(() => undefined)
      return
    }
    await expect(dontShow).toBeVisible({ timeout: 1_000 }).catch(() => undefined)
  }
}

const navToBoard = async (page: Page): Promise<void> => {
  // Plan-mode cards render a right-side worktree/Changes panel that narrows the board;
  // use a wide viewport so all columns (esp. Human Require) stay fully in-frame.
  await page.setViewportSize({ width: 1920, height: 900 })
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
  await dismissTips(page)
}

const col = (page: Page, c: string) => page.getByTestId(`kanban-column-${c}`)

// Wait until a card has finished its layout-slide animation into a column: poll until the
// card's box is fully within the column's horizontal bounds (mid-slide, coming from an
// adjacent column, it overhangs one side and is visually clipped). Direction-agnostic
// event-driven geometry check, not a fixed sleep.
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

// ═══════════════════════════════════════════════════════════════════════════
// Phase 14 — TC10: plan ready → Human Require; approve (implement) → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC10 — plan_ready routes to Human Require; approve returns to In Progress', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC10 planready sentinel'

  // 14.1 context
  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await screenshot(page, 'tc10-14.1-context', { fullPage: true })

  // 14.2 start In Progress
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc10-14.2-start-inprogress', { fullPage: true })

  // 14.3 plan_ready → Human Require
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc10,
    status: 'plan_ready',
    metadata: { toolName: 'ExitPlanMode', plan: 'TC10 plan — add the Human Require column' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  // Wait out any layout animation so the card is actually painted in the HR column body.
  await settledInColumn(page, 'human_required', TITLE)
  await screenshot(page, 'tc10-14.3-planready-hr', { fullPage: true })

  // 14.4 approve (PostToolUse ExitPlanMode → implement/working) → In Progress
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc10,
    status: 'working',
    metadata: { hookEventName: 'PostToolUse', toolName: 'ExitPlanMode' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await settledInColumn(page, 'in_progress', TITLE)
  await screenshot(page, 'tc10-14.4-approve-inprogress', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 15 — TC11: plan ready → Human Require; followup (revise/reject) → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC11 — plan_ready routes to Human Require; followup returns to In Progress', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'HUMANREQ TC11 planfollowup sentinel'

  // 15.1 context
  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await screenshot(page, 'tc11-15.1-context', { fullPage: true })

  // 15.2 start In Progress
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc11-15.2-start-inprogress', { fullPage: true })

  // 15.3 plan_ready → Human Require
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc11,
    status: 'plan_ready',
    metadata: { toolName: 'ExitPlanMode', plan: 'TC11 plan — draft' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  // Wait out any layout animation so the card is actually painted in the HR column body.
  await settledInColumn(page, 'human_required', TITLE)
  await screenshot(page, 'tc11-15.3-planready-hr', { fullPage: true })

  // 15.4 followup (UserPromptSubmit while plan_ready → plan_followup) → In Progress
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc11,
    status: 'planning',
    metadata: { hookEventName: 'UserPromptSubmit' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await settledInColumn(page, 'in_progress', TITLE)
  await screenshot(page, 'tc11-15.4-followup-inprogress', { fullPage: true })
})
