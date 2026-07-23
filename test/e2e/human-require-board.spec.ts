// E2E: ensure-hive-ticket-in-correct-co — Human Require board (structure + manual drag + reload persistence)
//
// File 1 of 5. TC01 (5-column render + order), TC02 (drag In Progress → Human Require),
// TC03 (Human Require placement survives a full reload). All actions are real UI gestures.
//
// DnD note: the board uses NATIVE HTML5 drag-and-drop and reads the dragged ticket from
// module-level state set in the card's `dragstart` handler (getKanbanDragData in
// useKanbanStore) — NOT from page.mouse gestures, which never fire dragstart. So drags are
// driven by dispatching real DragEvents with a DataTransfer, the pattern proven in
// worktree-branch-name-picker.spec.ts (TC09). Dropping into human_required takes the
// column's "move directly" branch (the worktree-picker interception is In-Progress-only).

import { test, expect, type Page } from '@playwright/test'
import { launchHiveBrowserApp, makeTempGitRepo, screenshot, type HiveApp } from './support/harness'

test.describe.configure({ mode: 'serial' })

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

const PROJECT = 'e2e-humanreq-project'
const TC02_TITLE = 'HUMANREQ TC02 drag sentinel'
const TC03_TITLE = 'HUMANREQ TC03 reload sentinel'

let app: HiveApp

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  // Suppress the async "Choose Your AI Agent" onboarding dialog (this host has multiple
  // real agent CLIs installed, so AgentSetupGuard shows a blocking picker otherwise).
  // Partial app_settings JSON merges over DEFAULT_SETTINGS on load (useSettingsStore
  // loadFromDatabase) — sanctioned fixture-phase settings seed.
  const settings = await app.rpcCall('db.setting.set', {
    key: 'app_settings',
    value: JSON.stringify({ initialSetupComplete: true, tipsEnabled: false })
  })
  expect(settings.ok, JSON.stringify(settings)).toBe(true)

  const repo = makeTempGitRepo('humanreq-board')
  const created = await app.rpcCall<ProjectRow>('db.project.create', { name: PROJECT, path: repo })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const projectId = created.value!.id

  for (const title of [TC02_TITLE, TC03_TITLE]) {
    const t = await app.rpcCall('kanban.ticket.create', {
      project_id: projectId,
      title,
      column: 'in_progress'
    })
    expect(t.ok, JSON.stringify(t)).toBe(true)
  }
})

test.afterAll(async () => {
  await app?.stop()
})

// ── Shared humanlike helpers ───────────────────────────────────────────────

// The host has multiple real agent CLIs installed → a "Choose Your AI Agent" AlertDialog
// mounts asynchronously on first project open. Clear it by picking Claude Code until no
// overlay remains. Event-driven (no fixed sleep): each pass waits on the overlay count.
const clearAgentPicker = async (page: Page): Promise<void> => {
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  for (let i = 0; i < 12; i++) {
    if ((await overlay.count()) === 0) return
    const claude = page.getByText('Claude Code', { exact: true }).first()
    if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
    await expect(overlay).toHaveCount(0, { timeout: 2_000 }).catch(() => undefined)
  }
}

// Board-nav pattern (precondition 0.6): goto → hydrate → select project → activate the
// board tab via the app's own DEV session store → assert a column rendered.
const navToBoard = async (page: Page): Promise<void> => {
  await page.goto(app.appUrl)
  await page.waitForLoadState('domcontentloaded')
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
      timeout: 25_000
    })
    .catch(() => undefined)
  await clearAgentPicker(page)
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

// Press-and-hold a card over a target column: dispatch dragstart on the draggable card +
// dragover on the column, leaving the drop indicator showing. Stashes the DataTransfer so
// a later drop reuses it. (handleDrop reads module state, not dataTransfer — the stash is
// only for symmetry.)
const holdDragOverColumn = async (
  page: Page,
  cardTitle: string,
  colTestId: string
): Promise<void> => {
  const cardEl = page.locator('[draggable="true"]').filter({ hasText: cardTitle }).first()
  await expect(cardEl).toBeVisible({ timeout: 10_000 })
  await cardEl.evaluate((el, colTestId) => {
    const dt = new DataTransfer()
    ;(window as unknown as { __e2eDragDt?: DataTransfer }).__e2eDragDt = dt
    const col = document.querySelector(`[data-testid="${colTestId}"]`)
    if (!col) throw new Error(`column ${colTestId} not found`)
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true }
    el.dispatchEvent(new DragEvent('dragstart', opts))
    col.dispatchEvent(new DragEvent('dragenter', opts))
    col.dispatchEvent(new DragEvent('dragover', opts))
  }, colTestId)
}

// Release the held drag: dispatch drop on the target column (fires the real move).
const dropOnColumn = async (page: Page, colTestId: string): Promise<void> => {
  await page.evaluate((colTestId) => {
    const dt = (window as unknown as { __e2eDragDt?: DataTransfer }).__e2eDragDt ?? new DataTransfer()
    const col = document.querySelector(`[data-testid="${colTestId}"]`)
    if (!col) throw new Error(`column ${colTestId} not found`)
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true }
    col.dispatchEvent(new DragEvent('drop', opts))
    col.dispatchEvent(new DragEvent('dragend', opts))
  }, colTestId)
}

// Whole drag in one shot (dragstart → dragover → drop → dragend), the proven combined form.
const dragCardIntoColumn = async (
  page: Page,
  cardTitle: string,
  colTestId: string
): Promise<void> => {
  await holdDragOverColumn(page, cardTitle, colTestId)
  await dropOnColumn(page, colTestId)
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 — TC01: board renders 5 columns with Human Require between In Progress & Review
// ═══════════════════════════════════════════════════════════════════════════
test('TC01 — five columns render with Human Require between In Progress and Review', async ({
  page
}) => {
  test.setTimeout(120_000)

  // 1.1 Open the app — context evidence (§1): the seeded project in the sidebar.
  await page.goto(app.appUrl)
  await page.waitForLoadState('domcontentloaded')
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
      timeout: 25_000
    })
    .catch(() => undefined)
  await clearAgentPicker(page)
  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc01-1.1-context', { fullPage: true })

  // 1.2 Open the seeded project's board.
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
  await screenshot(page, 'tc01-1.2-board-open', { fullPage: true })

  // 1.3 All five columns render, Human Require positioned between In Progress and Review.
  // The board is an overflow-x-auto container: at the default 1280px viewport the Review
  // and Done columns scroll off the right edge (fullPage does not capture horizontal
  // overflow). Widen the viewport so all five column headers fit in a single frame, then
  // scroll the board to its left origin so nothing is clipped left.
  await page.setViewportSize({ width: 1920, height: 900 })
  await page
    .getByTestId('kanban-board')
    .evaluate((el) => {
      el.scrollLeft = 0
    })
    .catch(() => undefined)
  await expect(page.getByTestId('kanban-column-todo')).toBeVisible()
  await expect(page.getByTestId('kanban-column-in_progress')).toBeVisible()
  await expect(page.getByTestId('kanban-column-human_required')).toBeVisible()
  await expect(page.getByTestId('kanban-column-review')).toBeVisible()
  await expect(page.getByTestId('kanban-column-done')).toBeVisible()
  await expect(page.getByTestId('kanban-column-human_required')).toContainText('Human Require')
  const ip = await page.getByTestId('kanban-column-in_progress').boundingBox()
  const hr = await page.getByTestId('kanban-column-human_required').boundingBox()
  const rv = await page.getByTestId('kanban-column-review').boundingBox()
  expect(ip!.x).toBeLessThan(hr!.x)
  expect(hr!.x).toBeLessThan(rv!.x)
  await screenshot(page, 'tc01-1.3-five-columns', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — TC02: dragging an In-Progress card into Human Require lands it there
// ═══════════════════════════════════════════════════════════════════════════
test('TC02 — drag a card from In Progress into Human Require', async ({ page }) => {
  test.setTimeout(120_000)
  await navToBoard(page)

  // 2.1 Context — the drag card starts in In Progress.
  await expect(
    page.getByTestId('kanban-column-in_progress').getByText(TC02_TITLE)
  ).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc02-2.1-context', { fullPage: true })

  // 2.2a BEFORE — card in In Progress, Human Require empty of this title.
  await expect(page.getByTestId('kanban-column-in_progress').getByText(TC02_TITLE)).toBeVisible()
  await expect(
    page.getByTestId('kanban-column-human_required').getByText(TC02_TITLE)
  ).toHaveCount(0)
  await screenshot(page, 'tc02-2.2a-drag-before', { fullPage: true })

  // 2.2b DURING — hold the card over Human Require; the drop indicator shows.
  await holdDragOverColumn(page, TC02_TITLE, 'kanban-column-human_required')
  await expect(page.getByTestId('drop-indicator-human_required')).toBeVisible()
  await screenshot(page, 'tc02-2.2b-drag-during', { fullPage: true })

  // 2.2c AFTER — drop; card is now in Human Require, gone from In Progress.
  await dropOnColumn(page, 'kanban-column-human_required')
  await expect(
    page.getByTestId('kanban-column-human_required').getByText(TC02_TITLE)
  ).toBeVisible()
  await expect(
    page.getByTestId('kanban-column-in_progress').getByText(TC02_TITLE)
  ).toHaveCount(0)
  await screenshot(page, 'tc02-2.2c-drag-after', { fullPage: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — TC03: a Human Require placement survives a full board reload
// ═══════════════════════════════════════════════════════════════════════════
test('TC03 — Human Require placement persists across a full reload', async ({ page }) => {
  test.setTimeout(120_000)
  await navToBoard(page)

  // 3.1 Context — the reload card starts in In Progress.
  await expect(
    page.getByTestId('kanban-column-in_progress').getByText(TC03_TITLE)
  ).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc03-3.1-context', { fullPage: true })

  // 3.2 Drag the card into Human Require.
  await dragCardIntoColumn(page, TC03_TITLE, 'kanban-column-human_required')
  await expect(
    page.getByTestId('kanban-column-human_required').getByText(TC03_TITLE)
  ).toBeVisible()
  await screenshot(page, 'tc03-3.2-placed-in-hr', { fullPage: true })

  // 3.3 Reload the whole app and re-open the board (fresh backend load).
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
      timeout: 25_000
    })
    .catch(() => undefined)
  await clearAgentPicker(page)
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
  await screenshot(page, 'tc03-3.3-after-reload', { fullPage: true })

  // 3.4 The card is STILL in Human Require after the reload, not back in In Progress.
  await expect(
    page.getByTestId('kanban-column-human_required').getByText(TC03_TITLE)
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByTestId('kanban-column-in_progress').getByText(TC03_TITLE)
  ).toHaveCount(0)
  await screenshot(page, 'tc03-3.4-persisted', { fullPage: true })
})
