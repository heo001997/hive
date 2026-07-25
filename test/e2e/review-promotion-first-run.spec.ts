// E2E: when-a-hive-ticket-first-run-in — a ticket's FIRST CLI run must not jump to Review
//
// Reproduces the reported bug end-to-end: launching a ticket in the Hive Claude Code CLI
// moved its card from In Progress to Review within ~2s, before the agent had done any
// work. Three independent defects fed it, each covered here:
//
//   TC01 `pty_start`      — the promptless createClaudeCli that the terminal component
//                           fires right after a launch published status 'completed' for a
//                           session that was booting → the board armed the Review
//                           promotion at spawn time.
//   TC02 `SessionStart`   — the CLI's own session-start hook maps to 'completed' for the
//                           "Ready" badge; that is not a turn end either.
//   TC03 resume race      — the promote decision awaits a fingerprint round-trip. A
//                           `working` resume landing DURING that await used to lose the
//                           race (production log: 123ms before the move) and, because the
//                           status was already `working`, no later edge could rescue the
//                           ticket — it stranded in Review with a live agent.
//   TC04 control          — a genuine `Stop` still promotes to Review (the fixes must not
//                           disable the promotion they guard).
//
// Triggers use the sanctioned /api/events/publish seam (publishEvent → real eventBus → WS
// → useClaudeCliStatusListener → useWorktreeStatusStore → kanban sync bridge). There is no
// real Claude CLI process in browser E2E, so a status push is the faithful analog of "the
// CLI emitted this status"; the metadata is exactly what claude-hook-server /
// terminal-pty-bridge attach in production.
//
// Cards are seeded in_progress + mode:'build' — the only shape the In Progress ⟺ Review
// promotion acts on.

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

const PROJECT = 'e2e-firstrun-project'
const CARDS = [
  { key: 'tc01', title: 'FIRSTRUN TC01 ptystart sentinel' },
  { key: 'tc02', title: 'FIRSTRUN TC02 sessionstart sentinel' },
  { key: 'tc03', title: 'FIRSTRUN TC03 resumerace sentinel' },
  { key: 'tc04', title: 'FIRSTRUN TC04 cleanstop sentinel' }
] as const

// current_session_id has a FOREIGN KEY to sessions(id) — each card needs a real session
// row to publish claude-cli:status against. Keyed by the CARDS key.
const SIDS: Record<string, string> = {}

let app: HiveApp

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  const settings = await app.rpcCall('db.setting.set', {
    key: 'app_settings',
    value: JSON.stringify({ initialSetupComplete: true, tipsEnabled: false })
  })
  expect(settings.ok, JSON.stringify(settings)).toBe(true)

  const repo = makeTempGitRepo('firstrun-review-promotion')
  const created = await app.rpcCall<ProjectRow>('db.project.create', { name: PROJECT, path: repo })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const projectId = created.value!.id

  for (const c of CARDS) {
    const session = await app.rpcCall<{ id: string }>('db.session.create', {
      project_id: projectId,
      worktree_id: null,
      agent_sdk: 'claude-code-cli',
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

// ── Shared humanlike helpers (mirrors the human-require specs) ─────────────
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

const col = (page: Page, c: string): ReturnType<Page['getByTestId']> =>
  page.getByTestId(`kanban-column-${c}`)

// Widen + scroll so the Review column (off-screen at 1280px) is in-frame for evidence.
const showReviewColumn = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page
    .getByTestId('kanban-board')
    .evaluate((el) => {
      el.scrollLeft = 0
    })
    .catch(() => undefined)
}

// The promotion is a poll (5s cadence) behind a frozen check; a negative assertion has to
// outlast at least one full cycle to mean anything.
const PROMOTE_SETTLE_MS = 8_000

/**
 * Fail the moment the card shows up in Review, for the whole window.
 *
 * A settle-then-look assertion is NOT enough here: on the unfixed build a single
 * spawn-time `completed` made the card FLAP — measured on this same fixture, it reached
 * Review at T+1.5s, got bounced back to In Progress at T+9.6s, returned to Review at
 * T+17.7s… So a check at T+8s can find the card sitting innocently in In Progress while
 * the bug is in full swing. Sampling catches the transient.
 */
const expectNeverInReview = async (page: Page, title: string, windowMs: number): Promise<void> => {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    const seen = await col(page, 'review').getByText(title).count()
    expect(seen, `card "${title}" must never reach Review on a spawn-time status`).toBe(0)
    await page.waitForTimeout(250)
  }
}

test('TC01 — a pty_start completed (terminal just spawned) keeps the card In Progress', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'FIRSTRUN TC01 ptystart sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'firstrun-tc01-1-before', { fullPage: true })

  // sanctioned event-injection seam — exactly what terminal-pty-bridge publishes when a
  // promptless Claude CLI PTY starts (the second create of a ticket launch).
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc01,
    status: 'completed',
    metadata: { reason: 'pty_start' }
  })

  await expectNeverInReview(page, TITLE, PROMOTE_SETTLE_MS)
  await showReviewColumn(page)
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'firstrun-tc01-2-after-stays-inprogress', { fullPage: true })
})

test('TC02 — a SessionStart-hook completed keeps the card In Progress', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'FIRSTRUN TC02 sessionstart sentinel'

  await navToBoard(page)
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'firstrun-tc02-1-before', { fullPage: true })

  // sanctioned event-injection seam — claude-hook-server maps the CLI's SessionStart hook
  // to 'completed' (the idle "Ready" badge), which is NOT a turn end.
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc02,
    status: 'completed',
    metadata: { hookEventName: 'SessionStart', hookPath: 'session' }
  })

  await expectNeverInReview(page, TITLE, PROMOTE_SETTLE_MS)
  await showReviewColumn(page)
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'firstrun-tc02-2-after-stays-inprogress', { fullPage: true })
})

test('TC03 — a resume during the frozen check does not let the promotion land', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'FIRSTRUN TC03 resumerace sentinel'

  await navToBoard(page)
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'firstrun-tc03-1-before', { fullPage: true })

  // A genuine turn end arms the promotion; its frozen check then awaits a fingerprint
  // round-trip (the no-PTY path samples twice, ~1.2s apart).
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc03,
    status: 'completed',
    metadata: { hookEventName: 'Stop' }
  })
  // …and the agent picks work back up mid-check (next turn / queued follow-up), which is
  // the production ordering that used to lose the race.
  await page.waitForTimeout(250)
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc03,
    status: 'working',
    metadata: { hookEventName: 'UserPromptSubmit' }
  })

  await expectNeverInReview(page, TITLE, PROMOTE_SETTLE_MS)
  await showReviewColumn(page)
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'firstrun-tc03-2-after-stays-inprogress', { fullPage: true })
})

test('TC04 — control: a clean Stop with no resume still promotes to Review', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'FIRSTRUN TC04 cleanstop sentinel'

  await navToBoard(page)
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'firstrun-tc04-1-before', { fullPage: true })

  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc04,
    status: 'completed',
    metadata: { hookEventName: 'Stop' }
  })

  await expect(col(page, 'review').getByText(TITLE)).toBeVisible({ timeout: 20_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  await showReviewColumn(page)
  await expect(col(page, 'review').getByText(TITLE)).toBeVisible()
  await screenshot(page, 'firstrun-tc04-2-after-review', { fullPage: true })
})
