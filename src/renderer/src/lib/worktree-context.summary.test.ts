import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  getOrGenerate: vi.fn(),
  scriptState: { setupRunning: false, setupOutput: [] as string[], setupError: undefined as string | undefined }
}))

vi.mock('@/api/script-api', () => ({
  scriptApi: {
    onOutput: vi.fn(() => () => {}),
    getPort: vi.fn(async () => ({ port: null }))
  }
}))

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    getContext: vi.fn(async () => ({ success: true, context: null }))
  }
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ environmentVariables: [] }) }
}))

vi.mock('@/stores/useScriptStore', () => ({
  useScriptStore: { getState: () => ({ getScriptState: () => harness.scriptState }) }
}))

vi.mock('@/stores/useWorktreeContextCacheStore', () => ({
  useWorktreeContextCacheStore: { getState: () => ({ getOrGenerate: harness.getOrGenerate }) }
}))

import { prepareWorktreeContextLaunch, templateWantsSummary } from './worktree-context'

const scanTarget = { id: 'wt-1', path: '/repo/wt-1', branch_name: 'feature', base_branch: 'main' }

beforeEach(() => {
  harness.getOrGenerate.mockReset()
  harness.scriptState = { setupRunning: false, setupOutput: [], setupError: undefined }
})
afterEach(() => vi.clearAllMocks())

describe('templateWantsSummary', () => {
  it('detects the summary token', () => {
    expect(templateWantsSummary('hi {{WORKTREE_SUMMARY}} there')).toBe(true)
    expect(templateWantsSummary('only {{PORT}}')).toBe(false)
  })
})

describe('prepareWorktreeContextLaunch — AI summary gating', () => {
  it('gathers + injects the summary when the template uses the token', async () => {
    harness.getOrGenerate.mockResolvedValue('A Vite + Electron app. Run with pnpm dev.')

    const result = await prepareWorktreeContextLaunch({
      worktreeId: null,
      scanTarget,
      basePrompt: 'Do the task.',
      template: 'Branch {{BRANCH}}\nSummary: {{WORKTREE_SUMMARY}}'
    })

    expect(result.status).toBe('done')
    expect(harness.getOrGenerate).toHaveBeenCalledTimes(1)
    expect(harness.getOrGenerate).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1',
      branch: 'feature'
    })
    expect(result.prompt).toContain('A Vite + Electron app. Run with pnpm dev.')
  })

  it('does NOT gather when the template omits the summary token', async () => {
    const result = await prepareWorktreeContextLaunch({
      worktreeId: null,
      scanTarget,
      basePrompt: 'Do the task.',
      template: 'Branch {{BRANCH}} on port {{PORT}}'
    })

    expect(result.status).toBe('done')
    expect(harness.getOrGenerate).not.toHaveBeenCalled()
  })

  it('does NOT gather when setup is blocked, even if the token is present', async () => {
    harness.scriptState = { setupRunning: false, setupOutput: [], setupError: 'install failed' }

    const result = await prepareWorktreeContextLaunch({
      worktreeId: 'wt-1',
      scanTarget,
      basePrompt: 'Do the task.',
      template: 'Summary: {{WORKTREE_SUMMARY}}'
    })

    expect(result.status).toBe('blocked')
    expect(harness.getOrGenerate).not.toHaveBeenCalled()
  })
})
