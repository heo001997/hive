// E2E: ensure-hive-ticket-in-correct-co — every remaining Claude-Code run scenario
//
// Round 2 of the "is the ticket in the right column?" work. Files 1-5 (human-require-*)
// cover TC01-TC18: the Human Require column itself, the blocking CLI signals, the plan
// round-trip and the SDK path. This file covers the run states those left open — the ones
// that decide a column but were previously either wrong or untested:
//
//   TC19  sub-agent in flight: the main turn's Stop is deferred → stays In Progress, and
//         the completion that lands when the LAST sub-agent stops promotes it to Review.
//   TC20  the same sub-agent-deferred turn, but ended on an API error → Human Require,
//         NOT Review (the deferred stop is re-reported under its own StopFailure name).
//   TC21  a PLAN-mode run blocked on a structured question → Human Require, back on resume.
//   TC22  a PLAN-mode run blocked on a permission prompt → Human Require.
//   TC23  a BUILD-mode ticket whose agent presents a plan in-terminal → Human Require,
//         and approving the plan returns it to In Progress.
//   TC24  a session STARTING (SessionStart) must never read as a session finishing.
//   TC25  context compaction keeps a ticket In Progress (a quiet compacting agent is busy).
//   TC26  a PLAN-mode run that ends its turn → Human Require (the plan awaits the user).
//   TC27  a queued rider sharing a worktree session is not dragged off its column by that
//         session's plan.
//
// Triggers use the sanctioned /api/events/publish injection seam (publishEvent → real
// eventBus → WS → useClaudeCliStatusListener → useWorktreeStatusStore → kanban sync
// bridge). There is no real Claude CLI process in browser E2E, so the status push is the
// faithful analog of "the agent emitted a status" (precondition 0.4, F3). Each payload
// below is EXACTLY what the hook server publishes for that scenario — the hook-server
// resolution itself (sub-agent depth accounting, the deferred-stop kind, the untracked
// SubagentStop) lives in the main process and is covered by
// src/main/services/__tests__/claude-hook-server.test.ts. All other actions are UI.
//
// Every "must NOT move" test carries its own CONTROL card: the negative event goes to the
// subject, then a genuine clean Stop goes to the control, and the assertion only runs once
// the control has actually moved. That proves the promotion pipeline was live and had time
// to (wrongly) move the subject, instead of asserting into an idle app.

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

const PROJECT = 'e2e-column-scenarios-project'

const CARDS = [
  { key: 'tc19', title: 'COLUMN TC19 subagent-defer sentinel', column: 'in_progress', mode: 'build' },
  { key: 'tc20', title: 'COLUMN TC20 subagent-error sentinel', column: 'in_progress', mode: 'build' },
  { key: 'tc21', title: 'COLUMN TC21 plan-question sentinel', column: 'in_progress', mode: 'plan' },
  { key: 'tc22', title: 'COLUMN TC22 plan-permission sentinel', column: 'in_progress', mode: 'plan' },
  { key: 'tc23', title: 'COLUMN TC23 build-replan sentinel', column: 'in_progress', mode: 'build' },
  { key: 'tc24', title: 'COLUMN TC24 sessionstart sentinel', column: 'in_progress', mode: 'build' },
  { key: 'tc24ctl', title: 'COLUMN TC24 control sentinel', column: 'in_progress', mode: 'build' },
  { key: 'tc25', title: 'COLUMN TC25 compaction sentinel', column: 'in_progress', mode: 'build' },
  { key: 'tc25ctl', title: 'COLUMN TC25 control sentinel', column: 'in_progress', mode: 'build' },
  { key: 'tc26', title: 'COLUMN TC26 plan-finish sentinel', column: 'in_progress', mode: 'plan' },
  { key: 'tc27', title: 'COLUMN TC27 queued-rider sentinel', column: 'in_progress', mode: 'plan' },
  { key: 'tc27ctl', title: 'COLUMN TC27 control sentinel', column: 'in_progress', mode: 'plan' }
] as const

// A queued ticket that only borrows a shared worktree's session carries
// pending_launch_config — the rider guard every column-moving branch checks. Seeded in
// In Progress (where a dependency-queued rider waits) so nothing but that guard can
// explain it staying put.
const RIDER_KEYS = new Set<string>(['tc27'])

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

  const repo = makeTempGitRepo('column-cli-scenarios')
  const created = await app.rpcCall<ProjectRow>('db.project.create', { name: PROJECT, path: repo })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const projectId = created.value!.id

  for (const c of CARDS) {
    const session = await app.rpcCall<{ id: string }>('db.session.create', {
      project_id: projectId,
      worktree_id: null,
      agent_sdk: 'claude-code',
      mode: c.mode
    })
    expect(session.ok, JSON.stringify(session)).toBe(true)
    SIDS[c.key] = session.value!.id

    const t = await app.rpcCall('kanban.ticket.create', {
      project_id: projectId,
      title: c.title,
      column: c.column,
      mode: c.mode,
      current_session_id: session.value!.id,
      ...(RIDER_KEYS.has(c.key)
        ? { pending_launch_config: JSON.stringify({ prompt: 'queued behind a sibling' }) }
        : {})
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

// Every column (including Review, off-screen at the 1280px default) must be in frame:
// these TCs assert across the whole In Progress → Human Require → Review span.
const navToBoard = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1920, height: 1000 })
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
  await expect(page.getByTestId('kanban-column-review')).toBeVisible({ timeout: 15_000 })
}

const col = (page: Page, c: string): ReturnType<Page['getByTestId']> =>
  page.getByTestId(`kanban-column-${c}`)

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

/** The status the hook server publishes for a clean end-of-turn Stop. */
const cleanStop = { status: 'completed', metadata: { hookEventName: 'Stop', hookPath: 'stop' } }

// ═══════════════════════════════════════════════════════════════════════════
// Phase 14 — TC19: a Stop deferred behind a running sub-agent holds In Progress,
//                  and the resolved completion promotes to Review
// ═══════════════════════════════════════════════════════════════════════════
test('TC19 — sub-agent in flight keeps the card In Progress until the sub-agent finishes', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC19 subagent-defer sentinel'

  // 14.1 context
  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc19-14.1-context', TITLE)

  // 14.2 start column: In Progress
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc19-14.2-start-inprogress', { fullPage: true })

  // 14.3 the turn is running and dispatches a sub-agent (PreToolUse{Agent} → SubagentStart)
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc19,
    status: 'working',
    metadata: { hookEventName: 'PreToolUse', hookPath: 'tool', toolName: 'Agent' }
  })
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc19,
    status: 'working',
    metadata: { hookEventName: 'SubagentStart', hookPath: 'subagent' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc19-14.3-subagent-running', { fullPage: true })

  // 14.4 the MAIN turn ends while the sub-agent is still working. The hook server defers
  // that Stop and keeps reporting 'working' — the card must stay In Progress, never Review.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc19,
    status: 'working',
    metadata: { hookEventName: 'Stop', hookPath: 'stop' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc19-14.4-deferred-stop-stays', { fullPage: true })

  // 14.5 the last SubagentStop resolves the deferral: the hook server publishes the
  // completion under the ORIGINAL event name (Stop) → the card promotes to Review.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc19,
    status: 'completed',
    metadata: { hookEventName: 'Stop', hookPath: 'subagent' }
  })
  await expect(col(page, 'review').getByText(TITLE)).toBeVisible({ timeout: 20_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc19-14.5-after-review', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 15 — TC20: an errored turn resolved behind a sub-agent → Human Require
// ═══════════════════════════════════════════════════════════════════════════
test('TC20 — an API-error turn that resolves behind a sub-agent lands in Human Require', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC20 subagent-error sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc20-15.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc20-15.2-start-inprogress', { fullPage: true })

  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc20,
    status: 'working',
    metadata: { hookEventName: 'SubagentStart', hookPath: 'subagent' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc20-15.3-before', { fullPage: true })

  // The turn dies on a rate-limit/overload while the sub-agent runs. The deferral resolves
  // at the last SubagentStop, and the hook server re-reports it as the StopFailure it
  // actually was (hookPath 'subagent' shows which hook carried it) — so the ticket must
  // reach Human Require (the user has to retry), not Review.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc20,
    status: 'completed',
    metadata: { hookEventName: 'StopFailure', hookPath: 'subagent' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 20_000 })
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc20-15.4-after-hr', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 16 — TC21: a PLAN-mode run blocked on a question → Human Require → back
// ═══════════════════════════════════════════════════════════════════════════
test('TC21 — a plan-mode ticket blocked on a question routes to Human Require and back', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC21 plan-question sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc21-16.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc21-16.2-start-inprogress', { fullPage: true })

  // A planning agent asks a clarifying question (the `/speckit-clarify` shape):
  // PreToolUse{AskUserQuestion} → 'answering'. Blocked is blocked in EVERY mode.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc21,
    status: 'answering',
    metadata: { hookEventName: 'PreToolUse', hookPath: 'permission', toolName: 'AskUserQuestion' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc21-16.3-enter-hr', { fullPage: true })

  // The user answers in the terminal → PostToolUse{AskUserQuestion} → planning resumes.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc21,
    status: 'planning',
    metadata: { hookEventName: 'PostToolUse', hookPath: 'tool', toolName: 'AskUserQuestion' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc21-16.4-resume-inprogress', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 17 — TC22: a PLAN-mode run blocked on a permission prompt → Human Require
// ═══════════════════════════════════════════════════════════════════════════
test('TC22 — a plan-mode ticket blocked on a permission prompt routes to Human Require', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC22 plan-permission sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc22-17.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc22-17.2-start-inprogress', { fullPage: true })

  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc22,
    status: 'permission',
    metadata: { hookEventName: 'PermissionRequest', hookPath: 'permission', toolName: 'Bash' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc22-17.3-after-hr', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 18 — TC23: a BUILD ticket whose agent plans in-terminal → Human Require → back
// ═══════════════════════════════════════════════════════════════════════════
test('TC23 — an in-terminal plan on a build ticket routes to Human Require, approval returns it', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC23 build-replan sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc23-18.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc23-18.2-start-inprogress', { fullPage: true })

  // The agent entered plan mode inside the terminal (Shift+Tab) — or is re-planning after
  // an earlier plan was approved, which flipped the ticket to mode 'build' — and now waits
  // on the plan menu: PermissionRequest{ExitPlanMode} → 'plan_ready'. The CLI is silent
  // while it waits, so this must be Human Require, not In Progress and not Review.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc23,
    status: 'plan_ready',
    metadata: { hookEventName: 'PermissionRequest', hookPath: 'permission', toolName: 'ExitPlanMode' }
  })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc23-18.3-enter-hr', { fullPage: true })

  // The user approves the plan in the terminal → PostToolUse{ExitPlanMode} → work resumes.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc23,
    status: 'working',
    metadata: { hookEventName: 'PostToolUse', hookPath: 'tool', toolName: 'ExitPlanMode' }
  })
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc23-18.4-resume-inprogress', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 19 — TC24: a session STARTING must not read as a session finishing
// ═══════════════════════════════════════════════════════════════════════════
test('TC24 — a SessionStart does not promote an In Progress card to Review', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC24 sessionstart sentinel'
  const CONTROL = 'COLUMN TC24 control sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc24-19.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(CONTROL)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc24-19.2-start-inprogress', { fullPage: true })

  // The CLI process for this ticket was just (re)spawned — opening a ticket whose process
  // died, `/clear`, `--resume`. The hook server maps SessionStart to the same 'completed'
  // value as a finished turn, so the board must recognise it and NOT promote.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc24,
    status: 'completed',
    metadata: { hookEventName: 'SessionStart', hookPath: 'session' }
  })
  // CONTROL: a genuine end-of-turn Stop on a sibling card. Waiting for the control to reach
  // Review proves the promotion pipeline was live for this exact window.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', { sessionId: SIDS.tc24ctl, ...cleanStop })
  await expect(col(page, 'review').getByText(CONTROL)).toBeVisible({ timeout: 20_000 })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc24-19.3-after-stays-inprogress', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 20 — TC25: context compaction keeps the ticket In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC25 — a compacting session keeps its card In Progress', async ({ page }) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC25 compaction sentinel'
  const CONTROL = 'COLUMN TC25 control sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc25-20.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc25-20.2-start-inprogress', { fullPage: true })

  // Auto-compaction: the agent is busy and the tty falls quiet for a long stretch, so the
  // hook reports 'working' — the card must stay In Progress (and the quiet must not be
  // mistaken for a finished session).
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc25,
    status: 'working',
    metadata: { hookEventName: 'PreCompact', hookPath: 'compact' }
  })
  // CONTROL (see TC24): proves the pipeline was live across this window.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', { sessionId: SIDS.tc25ctl, ...cleanStop })
  await expect(col(page, 'review').getByText(CONTROL)).toBeVisible({ timeout: 20_000 })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc25-20.3-after-stays-inprogress', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 21 — TC26: a plan-mode turn that ends → Human Require (plan awaits the user)
// ═══════════════════════════════════════════════════════════════════════════
test('TC26 — a plan-mode run that ends its turn lands in Human Require, not Review', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC26 plan-finish sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc26-21.1-context', TITLE)

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc26-21.2-start-inprogress', { fullPage: true })

  // A planning session's turn ends. Nothing was built, so Review (finished work) is wrong —
  // the plan is waiting on the user.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', { sessionId: SIDS.tc26, ...cleanStop })
  await expect(col(page, 'human_required').getByText(TITLE)).toBeVisible({ timeout: 20_000 })
  await expect(col(page, 'review').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc26-21.3-after-hr', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 22 — TC27: a queued rider is not dragged off its column by its host session's plan
// ═══════════════════════════════════════════════════════════════════════════
test('TC27 — a queued rider stays put while a plan_ready moves the ticket that owns the session', async ({
  page
}) => {
  test.setTimeout(120_000)
  const TITLE = 'COLUMN TC27 queued-rider sentinel'
  const CONTROL = 'COLUMN TC27 control sentinel'

  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await shotCard(page, 'tc27-22.1-context', TITLE)

  // A dependency-queued rider waits In Progress, so the rider guard is the ONLY thing
  // keeping it out of Human Require here — a source-column check could not mask it.
  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc27-22.2-start-inprogress', { fullPage: true })

  // A queued ticket sharing a worktree only borrows the running session — a plan presented
  // by that session belongs to the ticket that owns it, so the rider must not move (it is
  // still queued; its own run has not started).
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc27,
    status: 'plan_ready',
    metadata: { hookEventName: 'PermissionRequest', hookPath: 'permission', toolName: 'ExitPlanMode' }
  })
  // CONTROL: the same event on a non-rider card DOES move it — proving the event reached
  // the board and the rider's stillness is the guard, not a dead pipeline.
  // sanctioned event-injection seam (F3 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'claude-cli:status', {
    sessionId: SIDS.tc27ctl,
    status: 'plan_ready',
    metadata: { hookEventName: 'PermissionRequest', hookPath: 'permission', toolName: 'ExitPlanMode' }
  })
  await expect(col(page, 'human_required').getByText(CONTROL)).toBeVisible({ timeout: 20_000 })

  await expect(col(page, 'in_progress').getByText(TITLE)).toBeVisible()
  await expect(col(page, 'human_required').getByText(TITLE)).toHaveCount(0)
  await screenshot(page, 'tc27-22.3-after-stays-inprogress', { fullPage: true })
})
