// E2E: worktree-creation-offer-speckit — branch-name picker (the jsdom gap).
// Drives the REAL Hive app in browser mode: seed project + ticket via sanctioned
// rpcCall fixtures, then a human-like journey opens the worktree picker and
// exercises the speckit branch-name candidates (Popover inside a modal Dialog —
// the interaction jsdom cannot click). See .hive-e2e/worktree-creation-offer-speckit/.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchHiveBrowserApp, makeTempGitRepo, screenshot, type HiveApp } from './support/harness'

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

// The host has multiple real agent CLIs installed, so a "Choose Your AI Agent"
// modal mounts at a non-deterministic time on first project open. The spec clears
// it defensively, but retry once more to absorb the rare timing miss.
test.describe.configure({ retries: 1 })

const TICKET_TITLE = 'Export customer analytics dashboard'
// Ground-truth values (executed generator against branch-utils.ts):
const SHORT = 'export-customer-analytics-dashboard'
const SEQUENTIAL = '008-export-customer-analytics-dashboard'
const TIMESTAMP_RE = /^\d{8}-\d{6}-export-customer-analytics-dashboard$/

let app: HiveApp

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()

  // On-disk half of the fixture: a temp git repo with two EXISTING numbered
  // branches so the Sequential candidate must compute 008 (highest 007 + 1).
  const repoPath = makeTempGitRepo('wtpick')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
  }
  git(['branch', '001-alpha'])
  git(['branch', '007-legacy-thing'])

  const created = await app.rpcCall<ProjectRow>('db.project.create', {
    name: 'e2e-wtpick-project',
    path: repoPath
  })
  expect(created.ok, JSON.stringify(created)).toBe(true)

  // Ticket: simple (current_session_id null) + non-todo → the card's
  // "Assign to worktree" context-menu item is shown.
  const ticket = await app.rpcCall('kanban.ticket.create', {
    project_id: created.value!.id,
    title: TICKET_TITLE,
    column: 'in_progress'
  })
  expect(ticket.ok, JSON.stringify(ticket)).toBe(true)
})

test.afterAll(async () => {
  await app?.stop()
})

test('worktree picker offers speckit branch-name candidates and applies the pick', async ({
  page
}) => {
  test.setTimeout(120_000)
  const diag: string[] = []
  page.on('console', (m) => diag.push(`console.${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => diag.push(`pageerror: ${e.message}`))

  await page.goto(app.appUrl)
  await page.waitForLoadState('domcontentloaded')
  // App renders <div/> until initPlatform() resolves + web-mode auth loads; wait
  // for real content to hydrate before asserting anything.
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
      timeout: 25_000
    })
    .catch(() => undefined)
  await screenshot(page, 'wtpick-01-initial', { fullPage: true })

  // Multiple agents are installed on this host → a "Choose Your AI Agent" modal
  // (a blocking AlertDialog) appears asynchronously after the first project open.
  // Poll-and-clear it: pick Claude Code until no overlay remains. Robust against
  // the variable timing of when the picker mounts.
  const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
  const clearAgentPicker = async (): Promise<void> => {
    for (let i = 0; i < 15; i++) {
      if ((await overlay.count()) === 0) return
      const claude = page.getByText('Claude Code', { exact: true }).first()
      if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
      await page.waitForTimeout(400)
    }
  }

  // Reach the board: select the seeded project, then open the board. Default
  // sticky-tab mode exposes no board button until a session exists, so activate
  // the board tab via the app's own test-exposed session store — navigation ONLY;
  // every feature interaction below is a real UI click on the actual rendered picker.
  const inProgressCol = page.getByTestId('kanban-column-in_progress')
  await page.locator('[data-testid^="project-item-"]').first().click()
  await clearAgentPicker()
  await page.evaluate(() => {
    const w = window as unknown as {
      __hive_useSessionStore__?: { getState(): { setActiveSession(id: string): void } }
    }
    w.__hive_useSessionStore__?.getState().setActiveSession('__board__')
  })
  await clearAgentPicker()
  await expect(inProgressCol).toBeVisible({ timeout: 15_000 })
  await screenshot(page, 'wtpick-02-board', { fullPage: true })

  // TC01 — open the worktree picker via the card's context menu. The agent
  // picker can mount late, so retry the right-click, clearing any picker between
  // attempts, until the "Assign to worktree" item appears.
  const card = page.getByText(TICKET_TITLE, { exact: false }).first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  const assignItem = page.getByTestId('ctx-assign-worktree')
  for (let attempt = 0; attempt < 6; attempt++) {
    await clearAgentPicker()
    await card.click({ button: 'right' }).catch(() => undefined)
    if (await assignItem.isVisible({ timeout: 2_000 }).catch(() => false)) break
  }
  await screenshot(page, 'wtpick-03-context-menu')
  await assignItem.click()

  const trigger = page.getByTestId('branch-name-trigger')
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await screenshot(page, 'wtpick-04-picker-open')

  // TC02 — open the candidate dropdown; all four kinds present.
  await trigger.click()
  const list = page.getByTestId('branch-name-candidates')
  await expect(list).toBeVisible()
  for (const kind of ['hive-default', 'sequential', 'timestamp', 'short-name']) {
    await expect(page.getByTestId(`branch-name-candidate-${kind}`)).toBeVisible()
  }
  await screenshot(page, 'wtpick-05-candidates')

  // TC06/07 — Sequential reflects existing branches (008-); Timestamp shape.
  // The candidate button renders label + hint + value on separate lines; the
  // value is the last line.
  await expect(page.getByTestId('branch-name-candidate-sequential')).toContainText(SEQUENTIAL)
  const tsLines = (await page.getByTestId('branch-name-candidate-timestamp').innerText())
    .trim()
    .split('\n')
  expect(tsLines[tsLines.length - 1].trim()).toMatch(TIMESTAMP_RE)

  // TC03 — pick Sequential → popover closes → trigger shows the value.
  await page.getByTestId('branch-name-candidate-sequential').click()
  await expect(list).toBeHidden()
  await expect(trigger).toContainText(SEQUENTIAL)
  await screenshot(page, 'wtpick-06-picked-sequential')

  // TC04 — pick Short-name → trigger shows the bare short name.
  await trigger.click()
  await page.getByTestId('branch-name-candidate-short-name').click()
  await expect(trigger).toContainText(SHORT)

  // TC05 — custom input live-sanitizes illegal characters.
  await trigger.click()
  const custom = page.getByTestId('branch-name-custom-input')
  await custom.fill('')
  await custom.pressSequentially('Feat: my/branch name!!')
  await expect(custom).toHaveValue('Feat-mybranch-name')
  await screenshot(page, 'wtpick-07-custom-sanitized')

  if (test.info().errors.length) console.log(diag.slice(-40).join('\n'))
})

test('TC08 — Send creates a REAL git branch named as the chosen candidate', async ({ page }) => {
  test.setTimeout(120_000)
  // Own instance: stub `claude` so Send's post-create session launch is a no-op
  // (resolveClaudeBinaryPath = `which claude`); confine HIVE_WORKTREES_DIR to a
  // temp dir so the REAL `git worktree add` can't leak into ~/.hive-dev-worktrees.
  // COREPACK_HOME points back at the real cache (HOME override hides it).
  const stubDir = mkdtempSync(join(tmpdir(), 'hive-e2e-stub-'))
  const claudeStub = join(stubDir, 'claude')
  writeFileSync(claudeStub, '#!/bin/sh\nexit 0\n')
  chmodSync(claudeStub, 0o755)
  const wtDir = mkdtempSync(join(tmpdir(), 'hive-e2e-wt-'))

  const app2 = await launchHiveBrowserApp({
    extraEnv: {
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      HIVE_WORKTREES_DIR: wtDir,
      COREPACK_HOME: join(process.env.HOME ?? '', '.cache', 'node', 'corepack'),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
    }
  })

  try {
    const repo2 = makeTempGitRepo('wtcreate')
    // Existing numbered branches so the Sequential candidate computes 008. The
    // Sequential value is DISTINGUISHABLE from the hive-default: a created branch
    // starting `008-` can only come from honoring the pick (the default never
    // would), so it proves the chosen name reached real creation — unlike the
    // short-name, whose 32-char truncation collides with the default.
    execFileSync('git', ['-C', repo2, 'branch', '001-alpha'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo2, 'branch', '007-legacy-thing'], { stdio: 'pipe' })
    const created = await app2.rpcCall<ProjectRow>('db.project.create', {
      name: 'e2e-wtcreate-project',
      path: repo2
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const ticket = await app2.rpcCall('kanban.ticket.create', {
      project_id: created.value!.id,
      title: TICKET_TITLE,
      column: 'in_progress'
    })
    expect(ticket.ok, JSON.stringify(ticket)).toBe(true)

    await page.goto(app2.appUrl)
    await page.waitForLoadState('domcontentloaded')
    await page
      .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
        timeout: 25_000
      })
      .catch(() => undefined)

    // Only `claude` is stubbed (codex/opencode are the real binaries), so agent
    // detection is stable and the picker dismisses cleanly on click.
    const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
    const clearAgentPicker = async (): Promise<void> => {
      for (let i = 0; i < 15; i++) {
        if ((await overlay.count()) === 0) return
        const claude = page.getByText('Claude Code', { exact: true }).first()
        if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
        await page.waitForTimeout(400)
      }
    }

    await page.locator('[data-testid^="project-item-"]').first().click()
    await clearAgentPicker()
    await page.evaluate(() => {
      const w = window as unknown as {
        __hive_useSessionStore__?: { getState(): { setActiveSession(id: string): void } }
      }
      w.__hive_useSessionStore__?.getState().setActiveSession('__board__')
    })
    await clearAgentPicker()
    await expect(page.getByTestId('kanban-column-in_progress')).toBeVisible({ timeout: 15_000 })

    // Open the picker via the card context menu; retry, clearing any late picker.
    const card = page.getByText(TICKET_TITLE, { exact: false }).first()
    await expect(card).toBeVisible({ timeout: 10_000 })
    const assignItem = page.getByTestId('ctx-assign-worktree')
    for (let attempt = 0; attempt < 6; attempt++) {
      await clearAgentPicker()
      await card.click({ button: 'right' }).catch(() => undefined)
      if (await assignItem.isVisible({ timeout: 2_000 }).catch(() => false)) break
    }
    await assignItem.click()
    const trigger = page.getByTestId('branch-name-trigger')
    await expect(trigger).toBeVisible({ timeout: 10_000 })
    await trigger.click()
    await page.getByTestId('branch-name-candidate-sequential').click()
    await expect(trigger).toContainText(SEQUENTIAL)
    await screenshot(page, 'wtpick-08-before-send', { fullPage: true })

    await page.getByTestId('wt-picker-send-btn').click()

    // The chosen name reaches real creation: a branch starting `008-` can only
    // come from honoring the Sequential pick (the ticket-title default never does).
    // Poll `git branch` until it appears (folder/branch names truncate to 32 chars).
    await expect
      .poll(
        () => {
          try {
            return execFileSync('git', ['-C', repo2, 'branch', '--list', '008-*'], {
              encoding: 'utf-8'
            }).trim()
          } catch {
            return ''
          }
        },
        { timeout: 30_000, message: 'a git branch named after the Sequential pick (008-) should be created' }
      )
      .toContain('008-export-customer-analytics')
    await screenshot(page, 'wtpick-10-branch-created', { fullPage: true })
  } finally {
    await app2.stop()
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(wtDir, { recursive: true, force: true })
  }
})

test('TC09 — Send on a BLOCKED ticket persists the chosen name to pending_launch_config', async ({
  page
}) => {
  test.setTimeout(120_000)
  // No stub needed: a blocked ticket's Send saves the launch config and launches
  // nothing (no worktree, no agent). Drag the dependent ticket to In Progress →
  // the save-config-only picker opens.
  const app3 = await launchHiveBrowserApp()
  try {
    const repo3 = makeTempGitRepo('wtblocked')
    execFileSync('git', ['-C', repo3, 'branch', '001-alpha'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo3, 'branch', '007-legacy-thing'], { stdio: 'pipe' })
    const proj = await app3.rpcCall<ProjectRow>('db.project.create', {
      name: 'e2e-blocked-project',
      path: repo3
    })
    expect(proj.ok, JSON.stringify(proj)).toBe(true)
    const projectId3 = proj.value!.id

    const blocker = await app3.rpcCall<{ id: string }>('kanban.ticket.create', {
      project_id: projectId3,
      title: 'Blocker task',
      column: 'todo'
    })
    const dependent = await app3.rpcCall<{ id: string }>('kanban.ticket.create', {
      project_id: projectId3,
      title: TICKET_TITLE,
      column: 'todo'
    })
    expect(blocker.ok && dependent.ok, 'seed tickets').toBe(true)
    const depId = dependent.value!.id
    // Dependent is blocked by the (unsatisfied, todo) blocker.
    const dep = await app3.rpcCall('kanban.dependency.add', {
      projectId: projectId3,
      dependentId: depId,
      blockerId: blocker.value!.id
    })
    expect(dep.ok, JSON.stringify(dep)).toBe(true)

    await page.goto(app3.appUrl)
    await page.waitForLoadState('domcontentloaded')
    await page
      .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 0, null, {
        timeout: 25_000
      })
      .catch(() => undefined)

    const overlay = page.locator('[data-slot="alert-dialog-overlay"]')
    const clearAgentPicker = async (): Promise<void> => {
      for (let i = 0; i < 15; i++) {
        if ((await overlay.count()) === 0) return
        const claude = page.getByText('Claude Code', { exact: true }).first()
        if (await claude.isVisible().catch(() => false)) await claude.click().catch(() => undefined)
        await page.waitForTimeout(400)
      }
    }

    await page.locator('[data-testid^="project-item-"]').first().click()
    await clearAgentPicker()
    await page.evaluate(() => {
      const w = window as unknown as {
        __hive_useSessionStore__?: { getState(): { setActiveSession(id: string): void } }
      }
      w.__hive_useSessionStore__?.getState().setActiveSession('__board__')
    })
    await clearAgentPicker()
    await expect(page.getByTestId('kanban-column-todo')).toBeVisible({ timeout: 15_000 })
    await clearAgentPicker()

    // Drag the blocked dependent ticket To Do → In Progress → save-config picker.
    // The board uses native HTML5 DnD and reads drag state set in the `dragstart`
    // handler, which Playwright's mouse-based drag never fires — so dispatch the
    // real DnD events (dragstart → dragover → drop) with a shared DataTransfer.
    const cardEl = page.locator('[draggable="true"]').filter({ hasText: TICKET_TITLE }).first()
    await expect(cardEl).toBeVisible({ timeout: 10_000 })
    const trigger = page.getByTestId('branch-name-trigger')
    // The DnD dispatch races the dependency-map load (which decides blocked vs
    // unblocked) and the picker overlay; retry until the picker modal opens.
    for (let attempt = 0; attempt < 6; attempt++) {
      await clearAgentPicker()
      await cardEl
        .evaluate((el, colTestId) => {
          const dt = new DataTransfer()
          const col = document.querySelector(`[data-testid="${colTestId}"]`)
          if (!col) return
          const opts = { dataTransfer: dt, bubbles: true, cancelable: true }
          el.dispatchEvent(new DragEvent('dragstart', opts))
          col.dispatchEvent(new DragEvent('dragover', opts))
          col.dispatchEvent(new DragEvent('drop', opts))
          el.dispatchEvent(new DragEvent('dragend', opts))
        }, 'kanban-column-in_progress')
        .catch(() => undefined)
      if (await trigger.isVisible({ timeout: 3_000 }).catch(() => false)) break
    }
    await expect(trigger).toBeVisible({ timeout: 10_000 })
    await trigger.click()
    await page.getByTestId('branch-name-candidate-sequential').click()
    await expect(trigger).toContainText(SEQUENTIAL)
    await screenshot(page, 'wtpick-11-blocked-before-send', { fullPage: true })

    await page.getByTestId('wt-picker-send-btn').click()

    // Config-only: the chosen name is persisted into pending_launch_config, and
    // NO worktree branch is created.
    await expect
      .poll(
        async () => {
          const t = await app3.rpcCall<{ pending_launch_config: string | null }>(
            'kanban.ticket.get',
            { projectId: projectId3, id: depId }
          )
          return t.value?.pending_launch_config ?? ''
        },
        { timeout: 20_000, message: 'pending_launch_config should carry the chosen 008- name' }
      )
      .toContain('008-export-customer-analytics')
    const branches = execFileSync('git', ['-C', repo3, 'branch', '--format=%(refname:short)'], {
      encoding: 'utf-8'
    })
    expect(branches, 'no worktree branch created on the config-only path').not.toContain(
      '008-export-customer-analytics-dashboard'
    )
    await screenshot(page, 'wtpick-12-config-saved', { fullPage: true })
  } finally {
    await app3.stop()
  }
})
