// E2E: harness self-check — proves the shared harness helpers work end to end.
// Also the canonical example of the /speckit-e2e-* fixture pattern: one app boot per
// file (beforeAll), sanctioned RPC seeding of a project backed by a temp git repo,
// then UI-side verification against the isolated instance.
import { test, expect } from '@playwright/test'
import { launchHiveBrowserApp, makeTempGitRepo, screenshot, type HiveApp } from './support/harness'

test.describe.configure({ mode: 'serial' })

let app: HiveApp

test.beforeAll(async () => {
  app = await launchHiveBrowserApp()
})

test.afterAll(async () => {
  await app?.stop()
})

test('rpc ping answers on the isolated backend', async () => {
  const pong = await app.rpcCall('system.ping')
  expect(pong.ok, JSON.stringify(pong)).toBe(true)
})

test('fixture seeding: temp git repo + project row round-trips', async () => {
  const repo = makeTempGitRepo('harness-selfcheck')
  const created = await app.rpcCall<{ id: string; name: string }>('db.project.create', {
    name: 'e2e-harness-selfcheck',
    path: repo
  })
  expect(created.ok, JSON.stringify(created)).toBe(true)

  const projects = await app.rpcCall<Array<{ name: string }>>('db.project.getAll')
  expect(projects.ok, JSON.stringify(projects)).toBe(true)
  expect(projects.value?.some((p) => p.name === 'e2e-harness-selfcheck')).toBe(true)
})

test('renderer loads and screenshot helper writes to test-results/screenshots', async ({
  page
}) => {
  const response = await page.goto(app.appUrl)
  expect(response?.ok()).toBe(true)
  await page.waitForLoadState('domcontentloaded')
  const path = await screenshot(page, 'harness-selfcheck-renderer')
  expect(path).toContain('test-results/screenshots')
})
