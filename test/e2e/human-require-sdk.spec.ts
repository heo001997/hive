// E2E: ensure-hive-ticket-in-correct-co — Human Require SDK (OpenCode) blocked-on-user routing
//
// File 5 of 5. SDK (`opencode:stream`) blocked-on-user routing (F4) — the OpenCode listener
// half of the feature:
//   TC15 structured question (question.asked → HR; question.replied → In Progress)
//   TC16 permission (permission.asked → HR; permission.replied → In Progress)
//   TC17 command approval (command.approval_needed → HR; command.approval_replied → In Progress)
//
// Channel opencode:stream; event shape { sessionId, type, data } (isOpenCodeStreamEvent).
// TC15 fires session_question unconditionally. TC16/TC17 require commandFilter.enabled=true
// (with an empty allowlist checkAutoApprove returns false → NOT auto-approved → reach HR)
// AND a background session (sessionId !== active '__board__', satisfied). session_question /
// session_human_required only move build-mode In-Progress tickets → cards seeded mode:'build'
// with a real session (current_session_id FK). Replies call restoreSessionRunningStatus →
// working → session_working → In Progress. Triggers = the sanctioned /api/events/publish
// injection seam (precondition 0.4, F4).

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
  { key: 'tc15', title: 'HUMANREQ TC15 sdkquestion sentinel' },
  { key: 'tc16', title: 'HUMANREQ TC16 sdkpermission sentinel' },
  { key: 'tc17', title: 'HUMANREQ TC17 sdkcommand sentinel' }
] as const

const SIDS: Record<string, string> = {}

let app: HiveApp

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  // Suppress the agent-picker + tips, AND enable commandFilter so the SDK permission /
  // command-approval sub-paths are NOT auto-approved (precondition 0.8). Empty allowlist →
  // checkAutoApprove returns false → they reach Human Require.
  const settings = await app.rpcCall('db.setting.set', {
    key: 'app_settings',
    value: JSON.stringify({
      initialSetupComplete: true,
      tipsEnabled: false,
      commandFilter: { enabled: true, allowlist: [] }
    })
  })
  expect(settings.ok, JSON.stringify(settings)).toBe(true)

  const repo = makeTempGitRepo('humanreq-sdk')
  const created = await app.rpcCall<ProjectRow>('db.project.create', { name: PROJECT, path: repo })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const projectId = created.value!.id

  for (const c of CARDS) {
    const session = await app.rpcCall<{ id: string }>('db.session.create', {
      project_id: projectId,
      worktree_id: null,
      agent_sdk: 'opencode',
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

// ── Shared helpers (see File 1-4) ──────────────────────────────────────────
const clearAgentPicker = async (page: Page): Promise<void> => {
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  for (let i = 0; i < 12; i++) {
    if ((await overlay.count()) === 0) return
    const claude = page.getByText('Claude Code', { exact: true }).first()
    if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
    await expect(overlay).toHaveCount(0, { timeout: 2_000 }).catch(() => undefined)
  }
}

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

// Screenshot with the target card red-outlined (§11) — siblings share the same board, so
// highlighting the TC's distinctive card makes each frame visibly + byte-distinct.
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

// Wait until a card's layout-slide into a column has settled (fully within the column's
// horizontal bounds). Event-driven geometry check, not a fixed sleep.
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

// SDK round-trip: In Progress → blocking opencode:stream event → Human Require → reply → In Progress.
const runSdkRoundTrip = async (
  page: Page,
  opts: {
    title: string
    sid: string
    enterType: string
    enterData: Record<string, unknown>
    replyType: string
    replyData: Record<string, unknown>
    tc: string
    phase: number
  }
): Promise<void> => {
  const { title, sid, enterType, enterData, replyType, replyData, tc, phase } = opts
  const p = `${tc}-${phase}`

  // N.1 context
  await navToBoard(page)
  await expect(page.getByTestId('header-project-info')).toContainText(PROJECT)
  await expect(col(page, 'in_progress').getByText(title)).toBeVisible({ timeout: 15_000 })
  await shotCard(page, `${p}.1-context`, title)

  // N.2 start In Progress
  await expect(col(page, 'in_progress').getByText(title)).toBeVisible({ timeout: 15_000 })
  await shotCard(page, `${p}.2-start-inprogress`, title)

  // N.3 enter → Human Require
  // sanctioned event-injection seam (F4 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'opencode:stream', { sessionId: sid, type: enterType, data: enterData })
  await expect(col(page, 'human_required').getByText(title)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'in_progress').getByText(title)).toHaveCount(0)
  await settledInColumn(page, 'human_required', title)
  await screenshot(page, `${p}.3-enter-hr`, { fullPage: true })

  // N.4 reply → In Progress
  // sanctioned event-injection seam (F4 · precondition 0.4) — no UI alternative in browser E2E
  await publishEvent(app, 'opencode:stream', { sessionId: sid, type: replyType, data: replyData })
  await expect(col(page, 'in_progress').getByText(title)).toBeVisible({ timeout: 15_000 })
  await expect(col(page, 'human_required').getByText(title)).toHaveCount(0)
  await settledInColumn(page, 'in_progress', title)
  await screenshot(page, `${p}.4-resume-inprogress`, { fullPage: true })
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 16 — TC15: SDK structured question → Human Require; replied → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC15 — SDK question routes to Human Require and back on reply', async ({ page }) => {
  test.setTimeout(120_000)
  await runSdkRoundTrip(page, {
    title: 'HUMANREQ TC15 sdkquestion sentinel',
    sid: SIDS.tc15,
    enterType: 'question.asked',
    enterData: {
      id: 'q-tc15',
      sessionID: SIDS.tc15,
      questions: [{ id: 'q-tc15', text: 'TC15 — which approach?' }]
    },
    replyType: 'question.replied',
    replyData: { requestID: 'q-tc15' },
    tc: 'tc15',
    phase: 16
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 17 — TC16: SDK permission (non-auto-approvable) → Human Require; replied → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC16 — SDK permission routes to Human Require and back on reply', async ({ page }) => {
  test.setTimeout(120_000)
  await runSdkRoundTrip(page, {
    title: 'HUMANREQ TC16 sdkpermission sentinel',
    sid: SIDS.tc16,
    enterType: 'permission.asked',
    enterData: {
      id: 'p-tc16',
      sessionID: SIDS.tc16,
      permission: 'bash',
      patterns: ['rm -rf /tmp/tc16-sentinel'],
      metadata: {},
      always: []
    },
    replyType: 'permission.replied',
    replyData: { requestID: 'p-tc16' },
    tc: 'tc16',
    phase: 17
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 18 — TC17: SDK command approval → Human Require; replied → In Progress
// ═══════════════════════════════════════════════════════════════════════════
test('TC17 — SDK command approval routes to Human Require and back on reply', async ({ page }) => {
  test.setTimeout(120_000)
  await runSdkRoundTrip(page, {
    title: 'HUMANREQ TC17 sdkcommand sentinel',
    sid: SIDS.tc17,
    enterType: 'command.approval_needed',
    enterData: { id: 'c-tc17', sessionID: SIDS.tc17, toolName: 'Bash', command: 'echo TC17' },
    replyType: 'command.approval_replied',
    replyData: { requestID: 'c-tc17' },
    tc: 'tc17',
    phase: 18
  })
})
