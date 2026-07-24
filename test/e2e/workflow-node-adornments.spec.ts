// E2E: make-hive-visualization-better-s — workflow node adornments (TC04, TC05, TC06, TC07)
// Seeds pulse/gate/verdict/PR/worktree-union states via the sanctioned rpcCall
// fixtures (real sessions + worktrees to satisfy the FKs), then asserts the node
// adornments and the worktree-union dashed loop edge in the Workflow view.
import { test, expect, type Page } from '@playwright/test'
import { launchHiveBrowserApp, makeTempGitRepo, screenshot, type HiveApp } from './support/harness'

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

test.describe.configure({ mode: 'serial', retries: 1 })
let app: HiveApp

const GATE = {
  enabled: true,
  states: { review: { during: [{ id: 'condition-gate-evaluate', type: 'evaluate', config: {} }] } }
}

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
async function updateTicket(id: string, projectId: string, data: Record<string, unknown>): Promise<void> {
  const u = await app.rpcCall('kanban.ticket.update', { projectId, id, data })
  expect(u.ok, JSON.stringify(u)).toBe(true)
}
async function addDep(projectId: string, dependentId: string, blockerId: string): Promise<void> {
  const d = await app.rpcCall('kanban.dependency.add', { projectId, dependentId, blockerId })
  expect(d.ok, JSON.stringify(d)).toBe(true)
}
async function seedSession(projectId: string): Promise<string> {
  const s = await app.rpcCall<{ id: string }>('db.session.create', { worktree_id: null, project_id: projectId })
  expect(s.ok, JSON.stringify(s)).toBe(true)
  return s.value!.id
}
async function seedWorktree(projectId: string, name: string): Promise<string> {
  const w = await app.rpcCall<{ id: string }>('db.worktree.create', {
    project_id: projectId,
    name,
    branch_name: name,
    path: makeTempGitRepo(name)
  })
  expect(w.ok, JSON.stringify(w)).toBe(true)
  return w.value!.id
}
async function hydrate(page: Page): Promise<void> {
  await page.goto(app.appUrl)
  await page.waitForLoadState('domcontentloaded')
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, { timeout: 25_000 })
    .catch(() => undefined)
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
// Resilient to the agent-picker overlay racing in and intercepting the click.
async function selectProject(page: Page, projectName: string): Promise<void> {
  const item = page.locator('[data-testid^="project-item-"]').filter({ hasText: projectName }).first()
  for (let i = 0; i < 12; i++) {
    await clearAgentPicker(page)
    const clicked = await item.click({ timeout: 3000 }).then(() => true).catch(() => false)
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
const nodeByTitle = (page: Page, title: string) =>
  page.locator('.react-flow__node-ticket').filter({ hasText: title }).first()

let P04: string, P05: string, P06: string, P07: string

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
  // P04 — running node with a real live session (pulse)
  P04 = await seedProject('e2e-tc04-project')
  const sess = await seedSession(P04)
  const up = await seedTicket({ project_id: P04, title: 'TC04 upstream — ready', column: 'done' })
  const run = await seedTicket({ project_id: P04, title: 'TC04 running node — live session', column: 'in_progress', current_session_id: sess })
  await addDep(P04, run, up)
  // P05 — gate + verdict + fix round
  P05 = await seedProject('e2e-tc05-project')
  const impl5 = await seedTicket({ project_id: P05, title: 'TC05 Implement', column: 'done' })
  const gate5 = await seedTicket({ project_id: P05, title: 'TC05 Review (gate)', column: 'review', lifecycle_callbacks: GATE })
  await addDep(P05, gate5, impl5)
  await updateTicket(gate5, P05, {
    condition_gate_result: { ranAt: 1, trigger: 'auto', verdict: 'fix', source: 'llm-transcript', reason: 'e2e', fixes: ['x'], round: 0, maxRounds: 3, decision: 'fix', outcome: 'fix', action: 'launched fix round 1', sessionId: null }
  })
  const wt5 = await seedWorktree(P05, 'wt-tc05')
  await seedTicket({ project_id: P05, title: 'TC05 Fix (round 1)', column: 'todo', worktree_id: wt5 })
  // P06 — PR chip
  P06 = await seedProject('e2e-tc06-project')
  await seedTicket({ project_id: P06, title: 'TC06 Implement — with PR', column: 'done', github_pr_number: 4242, github_pr_url: 'https://github.com/example/repo/pull/4242' })
  // P07 — worktree union + solo negative
  P07 = await seedProject('e2e-tc07-project')
  const wtA = await seedWorktree(P07, 'wt-tc07')
  const spec7 = await seedTicket({ project_id: P07, title: 'TC07 Specify', column: 'done', worktree_id: wtA })
  const gate7 = await seedTicket({ project_id: P07, title: 'TC07 Review (gate)', column: 'review', lifecycle_callbacks: GATE, worktree_id: wtA })
  await addDep(P07, gate7, spec7)
  await seedTicket({ project_id: P07, title: 'TC07 Fix (round 1)', column: 'todo', worktree_id: wtA }) // NO dependency — worktree union only
  const wtB = await seedWorktree(P07, 'wt-other')
  await seedTicket({ project_id: P07, title: 'TC07 Solo other-worktree', column: 'todo', worktree_id: wtB })
})
test.afterAll(async () => {
  await app?.stop()
})

test('TC04 — running node pulses and the lane shows it is live', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc04-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc04-5.1-context')
  await openWorkflow(page, 'e2e-tc04-project')
  const run = nodeByTitle(page, 'TC04 running node — live session')
  await expect(run).toBeVisible()
  await screenshot(page, 'tc04-5.2-workflow-open', { fullPage: true })
  await expect(run.getByTestId('workflow-node-status')).toHaveText('Running')
  await screenshot(page, 'tc04-5.3-running-label')
  await expect(run.locator('.animate-pulse').first()).toBeVisible()
  await screenshot(page, 'tc04-5.4-pulse')
})

test('TC05 — gate frame, verdict pill, round badge', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc05-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc05-6.1-context')
  await openWorkflow(page, 'e2e-tc05-project')
  await screenshot(page, 'tc05-6.2-workflow-open', { fullPage: true })
  const gate = nodeByTitle(page, 'TC05 Review (gate)')
  await expect(gate.getByText('gate', { exact: true })).toBeVisible()
  await expect(gate.getByText('fix', { exact: true })).toBeVisible()
  await screenshot(page, 'tc05-6.3-gate-verdict')
  await expect(nodeByTitle(page, 'TC05 Fix (round 1)').getByText('↻1')).toBeVisible()
  await screenshot(page, 'tc05-6.4-round-badge')
})

test('TC06 — PR chip on a ticket with a pull request', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc06-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc06-7.1-context')
  await openWorkflow(page, 'e2e-tc06-project')
  const pr = nodeByTitle(page, 'TC06 Implement — with PR')
  await expect(pr).toBeVisible()
  await screenshot(page, 'tc06-7.2-workflow-open', { fullPage: true })
  await expect(pr.getByText('#4242')).toBeVisible()
  await screenshot(page, 'tc06-7.3-pr-chip')
})

test('TC07 — worktree union: fix joins the chain, solo stays separate', async ({ page }) => {
  test.setTimeout(120_000)
  await hydrate(page)
  await expect(page.getByText('e2e-tc07-project')).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'tc07-8.1-context')
  await openWorkflow(page, 'e2e-tc07-project')
  await expect(nodeByTitle(page, 'TC07 Fix (round 1)')).toBeVisible()
  await screenshot(page, 'tc07-8.2-workflow-open', { fullPage: true })
  // gate + fix both present; a dashed (stroke-dasharray) edge links them
  await expect(nodeByTitle(page, 'TC07 Review (gate)')).toBeVisible()
  await expect
    .poll(
      async () =>
        page.locator('.react-flow__edge-path').evaluateAll((els) =>
          els.some((e) => {
            const d = getComputedStyle(e as Element).strokeDasharray
            return !!d && d !== 'none' && d.trim() !== ''
          })
        ),
      { timeout: 10_000 }
    )
    .toBe(true)
  await screenshot(page, 'tc07-8.3-union-dashed-edge', { fullPage: true })
  // solo ticket is a separate lane → ≥2 lane-label nodes
  await expect(nodeByTitle(page, 'TC07 Solo other-worktree')).toBeVisible()
  const laneLabels = await page.locator('.react-flow__node-laneLabel').count()
  expect(laneLabels, `lane labels (chain + solo) = ${laneLabels}`).toBeGreaterThanOrEqual(2)
  await screenshot(page, 'tc07-8.4-separate-lane', { fullPage: true })
})
