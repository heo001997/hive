// E2E: make-hive-visualization-better-s — workflow board render (TC01, TC02, TC03, TC12)
// Drives the real isolated Hive app in browser mode: seed projects/tickets via the
// sanctioned rpcCall fixtures, then a human-like journey opens the Workflow view and
// asserts the DAG renders (nodes, status colors, blocked/ready, edges, no errors).
import { test, expect, type Page } from '@playwright/test'
import { launchHiveBrowserApp, makeTempGitRepo, screenshot, type HiveApp } from './support/harness'

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

test.describe.configure({ mode: 'serial', retries: 1 })
let app: HiveApp

// Poll-and-clear the "Choose Your AI Agent" AlertDialog (host has real agent CLIs).
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
  const created = await app.rpcCall<ProjectRow>('db.project.create', {
    name,
    path: makeTempGitRepo(name)
  })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.value!.id
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
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
      timeout: 25_000
    })
    .catch(() => undefined)
}
// Select a project, resilient to the agent-picker overlay racing in and intercepting
// the click: clear the picker, attempt the click, and on interception clear + retry.
async function selectProject(page: Page, projectName: string): Promise<void> {
  const item = page
    .locator('[data-testid^="project-item-"]')
    .filter({ hasText: projectName })
    .first()
  for (let i = 0; i < 12; i++) {
    await clearAgentPicker(page)
    const clicked = await item
      .click({ timeout: 3000 })
      .then(() => true)
      .catch(() => false)
    if (clicked) return
  }
  await clearAgentPicker(page)
  await item.click({ timeout: 8000 })
}
async function openWorkflow(page: Page, projectName: string): Promise<void> {
  await hydrate(page)
  await selectProject(page, projectName)
  await toggleWorkflow(page)
  await clearAgentPicker(page)
  await expect(page.getByTestId('workflow-board-view')).toBeVisible({ timeout: 15_000 })
}
// Click the Workflow toggle only once the agent-picker overlay is truly gone — the
// picker mounts asynchronously and otherwise intercepts the click (host flake).
async function toggleWorkflow(page: Page): Promise<void> {
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  for (let i = 0; i < 6; i++) {
    await clearAgentPicker(page)
    if ((await overlay.count()) === 0) break
  }
  await expect(overlay).toHaveCount(0, { timeout: 10_000 })
  await page.getByTestId('workflow-view-toggle').click()
}
// Target TICKET nodes only — the non-interactive lane-label node also renders the
// chain root's title, so an unscoped `.react-flow__node` filter would ambiguously
// match it (and it carries no status label).
const nodeByTitle = (page: Page, title: string) =>
  page.locator('.react-flow__node-ticket').filter({ hasText: title }).first()
// Assert a node's live status via its dedicated testid (the phase header can carry
// the same word as the status, e.g. a "Review" ticket sitting in the review column).
async function expectStatus(page: Page, title: string, label: string): Promise<void> {
  await expect(nodeByTitle(page, title).getByTestId('workflow-node-status')).toHaveText(label)
}

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  // P01 — chain (TC01)
  const p01 = await seedProject('e2e-tc01-project')
  const spec = await seedTicket({ project_id: p01, title: 'TC01 Specify — export dashboard', column: 'done' })
  const plan = await seedTicket({ project_id: p01, title: 'TC01 Plan — export dashboard', column: 'done' })
  const impl = await seedTicket({ project_id: p01, title: 'TC01 Implement — export dashboard', column: 'in_progress' })
  const rev = await seedTicket({ project_id: p01, title: 'TC01 Review (gate) — export dashboard', column: 'todo' })
  await addDep(p01, plan, spec)
  await addDep(p01, impl, plan)
  await addDep(p01, rev, impl)
  // P02 — status fan-out (TC02): every leaf blocked only by the DONE root
  const p02 = await seedProject('e2e-tc02-project')
  const root = await seedTicket({ project_id: p02, title: 'TC02 done', column: 'done' })
  // "Running" status label derives from column === 'in_progress' alone; no session
  // needed here (the live-session pulse is exercised separately in TC04).
  const run = await seedTicket({ project_id: p02, title: 'TC02 running', column: 'in_progress' })
  const revw = await seedTicket({ project_id: p02, title: 'TC02 review', column: 'review' })
  const todo = await seedTicket({ project_id: p02, title: 'TC02 todo', column: 'todo' })
  await addDep(p02, run, root)
  await addDep(p02, revw, root)
  await addDep(p02, todo, root)
  // P03 — blocked vs ready (TC03)
  const p03 = await seedProject('e2e-tc03-project')
  const bOpen = await seedTicket({ project_id: p03, title: 'TC03 blocker-open', column: 'in_progress' })
  const dBlocked = await seedTicket({ project_id: p03, title: 'TC03 dependent-blocked', column: 'todo' })
  const bDone = await seedTicket({ project_id: p03, title: 'TC03 blocker-done', column: 'done' })
  const dReady = await seedTicket({ project_id: p03, title: 'TC03 dependent-ready', column: 'todo' })
  await addDep(p03, dBlocked, bOpen)
  await addDep(p03, dReady, bDone)
  // P12 — linear (TC12)
  const p12 = await seedProject('e2e-tc12-project')
  const a = await seedTicket({ project_id: p12, title: 'TC12 A', column: 'done' })
  const b = await seedTicket({ project_id: p12, title: 'TC12 B', column: 'done' })
  const c = await seedTicket({ project_id: p12, title: 'TC12 C', column: 'todo' })
  await addDep(p12, b, a)
  await addDep(p12, c, b)
})
test.afterAll(async () => {
  await app?.stop()
})

test('TC01 — S-Chain: open Workflow view → chain renders as a DAG lane', async ({ page }) => {
  test.setTimeout(120_000)
  // 1.1 context
  await hydrate(page)
  await expect(page.getByText('e2e-tc01-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc01-1.1-context')
  // 1.2 select project
  await selectProject(page, 'e2e-tc01-project')
  await clearAgentPicker(page)
  await screenshot(page, 'tc01-1.2-project-selected')
  // 1.3 open Workflow
  await toggleWorkflow(page)
  await clearAgentPicker(page)
  await expect(page.getByTestId('workflow-board-view')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc01-1.3-workflow-open', { fullPage: true })
  // 1.4 chain nodes
  for (const t of [
    'TC01 Specify — export dashboard',
    'TC01 Plan — export dashboard',
    'TC01 Implement — export dashboard',
    'TC01 Review (gate) — export dashboard'
  ]) {
    await expect(nodeByTitle(page, t)).toBeVisible()
  }
  await screenshot(page, 'tc01-1.4-lane-nodes', { fullPage: true })
  // 1.5 legend present, no empty-state
  await expect(page.getByTestId('workflow-board-view').getByText('Done').first()).toBeVisible()
  await expect(page.getByText('No workflow to show yet.')).toHaveCount(0)
  await screenshot(page, 'tc01-1.5-legend')
})

test('TC02 — S-Chain: node base color reflects each ticket column', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc02-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc02-2.1-context')
  await openWorkflow(page, 'e2e-tc02-project')
  await screenshot(page, 'tc02-2.2-workflow-open', { fullPage: true })
  await expectStatus(page, 'TC02 done', 'Done')
  await screenshot(page, 'tc02-2.3-done')
  await expectStatus(page, 'TC02 running', 'Running')
  await screenshot(page, 'tc02-2.4-running')
  await expectStatus(page, 'TC02 review', 'Review')
  await expectStatus(page, 'TC02 todo', 'To do')
  await screenshot(page, 'tc02-2.5-review-todo', { fullPage: true })
})

test('TC03 — S-Chain: todo splits into Blocked vs To do', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc03-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc03-3.1-context')
  await openWorkflow(page, 'e2e-tc03-project')
  await screenshot(page, 'tc03-3.2-workflow-open', { fullPage: true })
  await expectStatus(page, 'TC03 dependent-blocked', 'Blocked')
  await screenshot(page, 'tc03-3.3-blocked')
  await expectStatus(page, 'TC03 dependent-ready', 'To do')
  await screenshot(page, 'tc03-3.4-ready')
})

test('TC12 — S-Chain: dependency edges render, graph raises no error', async ({ page }) => {
  test.setTimeout(120_000)
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await hydrate(page)
  await expect(page.getByText('e2e-tc12-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc12-4.1-context')
  await openWorkflow(page, 'e2e-tc12-project')
  for (const t of ['TC12 A', 'TC12 B', 'TC12 C']) {
    await expect(nodeByTitle(page, t)).toBeVisible()
  }
  await screenshot(page, 'tc12-4.2-workflow-open', { fullPage: true })
  // Edges are SVG <g>/<path>; count them rather than asserting visibility (Playwright's
  // visibility heuristic is unreliable on SVG group elements even when they render).
  await expect
    .poll(async () => page.locator('.react-flow__edge-path').count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2)
  const edgeCount = await page.locator('.react-flow__edge-path').count()
  expect(edgeCount, `edges drawn: ${edgeCount}`).toBeGreaterThanOrEqual(2)
  await screenshot(page, 'tc12-4.3-edges', { fullPage: true })
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toHaveLength(0)
  await expect(page.getByTestId('workflow-board-view')).toBeVisible()
  await screenshot(page, 'tc12-4.4-no-error', { fullPage: true })
})
