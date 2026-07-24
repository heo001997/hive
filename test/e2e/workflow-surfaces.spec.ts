// E2E: make-hive-visualization-better-s — workflow surfaces (TC08, TC09, TC10, TC11)
// Focus modal (View workflow), view-mode exclusivity, empty-state, and dark-theme
// rendering — all via humanlike UI journeys over the real isolated Hive app.
import { test, expect, type Page } from '@playwright/test'
import { launchHiveBrowserApp, makeTempGitRepo, screenshot, type HiveApp } from './support/harness'

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

test.describe.configure({ mode: 'serial', retries: 1 })
let app: HiveApp

async function clearAgentPicker(page: Page): Promise<void> {
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  for (let i = 0; i < 15; i++) {
    if ((await overlay.count()) === 0) return
    const claude = page.getByText('Claude Code', { exact: true }).first()
    if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
    await expect(overlay).toHaveCount(0, { timeout: 2000 }).catch(() => undefined)
  }
}
async function seedProject(name: string): Promise<string> {
  const c = await app.rpcCall<ProjectRow>('db.project.create', { name, path: makeTempGitRepo(name) })
  expect(c.ok, JSON.stringify(c)).toBe(true)
  return c.value!.id
}
async function seedTicket(p: Record<string, unknown>): Promise<string> {
  const t = await app.rpcCall<{ id: string }>('kanban.ticket.create', p)
  expect(t.ok, JSON.stringify(t)).toBe(true)
  return t.value!.id
}
async function addDep(projectId: string, dependentId: string, blockerId: string): Promise<void> {
  const d = await app.rpcCall('kanban.dependency.add', { projectId, dependentId, blockerId })
  expect(d.ok, JSON.stringify(d)).toBe(true)
}
async function hydrate(page: Page): Promise<void> {
  await page.goto(app.appUrl)
  await page.waitForLoadState('domcontentloaded')
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, { timeout: 25_000 })
    .catch(() => undefined)
}
// Resilient to the agent-picker overlay racing in and intercepting the click.
async function selectProject(page: Page, projectName: string): Promise<void> {
  const item = page.locator('[data-testid^="project-item-"]').filter({ hasText: projectName }).first()
  for (let i = 0; i < 12; i++) {
    await clearAgentPicker(page)
    const clicked = await item.click({ timeout: 3000 }).then(() => true).catch(() => false)
    if (clicked) {
      await clearAgentPicker(page)
      return
    }
  }
  await clearAgentPicker(page)
  await item.click({ timeout: 8000 })
  await clearAgentPicker(page)
}
async function toggleWorkflow(page: Page): Promise<void> {
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  for (let i = 0; i < 6; i++) {
    await clearAgentPicker(page)
    if ((await overlay.count()) === 0) break
  }
  await expect(overlay).toHaveCount(0, { timeout: 10_000 })
  await page.getByTestId('workflow-view-toggle').click()
}
async function openWorkflow(page: Page, projectName: string): Promise<void> {
  await hydrate(page)
  await selectProject(page, projectName)
  await toggleWorkflow(page)
  await clearAgentPicker(page)
  await expect(page.getByTestId('workflow-board-view')).toBeVisible({ timeout: 15_000 })
}
const nodeByTitle = (page: Page, title: string) =>
  page.locator('.react-flow__node-ticket').filter({ hasText: title }).first()

let P08: string, P09: string, P11: string

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  P08 = await seedProject('e2e-tc08-project')
  const s8 = await seedTicket({ project_id: P08, title: 'TC08 Specify', column: 'done' })
  const i8 = await seedTicket({ project_id: P08, title: 'TC08 Implement — focus target', column: 'in_progress' })
  await addDep(P08, i8, s8)
  P09 = await seedProject('e2e-tc09-project')
  await seedTicket({ project_id: P09, title: 'TC09 Specify — exclusivity', column: 'todo' })
  await seedProject('e2e-tc10-empty-project') // NO tickets (selected by name in TC10)
  P11 = await seedProject('e2e-tc11-project')
  await seedTicket({ project_id: P11, title: 'TC11 Plan — dark theme', column: 'in_progress' })
})
test.afterAll(async () => {
  await app?.stop()
})

test('TC08 — View workflow opens the per-chain focus modal', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc08-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc08-9.1-context')
  await openWorkflow(page, 'e2e-tc08-project')
  const node = nodeByTitle(page, 'TC08 Implement — focus target')
  await expect(node).toBeVisible()
  await screenshot(page, 'tc08-9.2-workflow-open', { fullPage: true })
  await node.dblclick()
  await expect(page.getByTestId('kanban-ticket-modal')).toBeVisible({ timeout: 10_000 })
  await screenshot(page, 'tc08-9.3-ticket-modal')
  await page.getByTestId('view-workflow-btn').click()
  await expect(page.getByTestId('workflow-chain-modal')).toBeVisible({ timeout: 10_000 })
  await expect(
    page
      .getByTestId('workflow-chain-modal')
      .locator('.react-flow__node-ticket')
      .filter({ hasText: 'TC08 Implement — focus target' })
      .first()
  ).toBeVisible()
  await screenshot(page, 'tc08-9.4-focus-modal', { fullPage: true })
})

test('TC09 — Workflow view exclusivity', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc09-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc09-10.1-context')
  await openWorkflow(page, 'e2e-tc09-project')
  await screenshot(page, 'tc09-10.2-workflow-on', { fullPage: true })
  // toggle off
  await page.getByTestId('workflow-view-toggle').click()
  await expect(page.getByTestId('workflow-board-view')).toHaveCount(0, { timeout: 10_000 })
  await screenshot(page, 'tc09-10.3-workflow-off', { fullPage: true })
  // workflow on, then war-room → workflow yields
  await toggleWorkflow(page)
  await expect(page.getByTestId('workflow-board-view')).toBeVisible()
  await page.getByTestId('war-room-toggle').click()
  await expect(page.getByTestId('workflow-board-view')).toHaveCount(0, { timeout: 10_000 })
  await screenshot(page, 'tc09-10.4-warroom-exclusive', { fullPage: true })
})

test('TC10 — empty board shows the empty state, not an empty graph', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc10-empty-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc10-11.1-context')
  await openWorkflow(page, 'e2e-tc10-empty-project')
  await screenshot(page, 'tc10-11.2-workflow-open', { fullPage: true })
  await expect(page.getByText('No workflow to show yet.')).toBeVisible()
  await expect(page.locator('.react-flow')).toHaveCount(0)
  await screenshot(page, 'tc10-11.3-empty-state', { fullPage: true })
})

test('TC11 — the graph renders themed in dark mode', async ({ page }) => {
  test.setTimeout(120_000)
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await hydrate(page)
  await expect(page.getByText('e2e-tc11-project')).toBeVisible({ timeout: 15_000 })
  // The app's default theme is a dark preset (glass-dark) → the root carries `dark`.
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
    timeout: 15_000
  })
  await screenshot(page, 'tc11-12.2-dark-theme')
  await openWorkflow(page, 'e2e-tc11-project')
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(nodeByTitle(page, 'TC11 Plan — dark theme')).toBeVisible()
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toHaveLength(0)
  await screenshot(page, 'tc11-12.3-dark-graph', { fullPage: true })
})
