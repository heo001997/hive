import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  generateContextSummary: vi.fn()
}))

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    generateContextSummary: harness.generateContextSummary
  }
}))

import { useWorktreeContextCacheStore } from './useWorktreeContextCacheStore'

const reset = (): void => {
  useWorktreeContextCacheStore.setState({ summaries: {} })
  harness.generateContextSummary.mockReset()
}

describe('useWorktreeContextCacheStore.getOrGenerate', () => {
  beforeEach(reset)
  afterEach(reset)

  it('generates once, then serves the cache on the next call (same branch)', async () => {
    harness.generateContextSummary.mockResolvedValue({ success: true, summary: 'a node app' })

    const first = await useWorktreeContextCacheStore.getState().getOrGenerate({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1',
      branch: 'feature'
    })
    const second = await useWorktreeContextCacheStore.getState().getOrGenerate({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1',
      branch: 'feature'
    })

    expect(first).toBe('a node app')
    expect(second).toBe('a node app')
    expect(harness.generateContextSummary).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent calls for the same worktree (one CLI gather)', async () => {
    let resolveRpc: (v: { success: boolean; summary: string }) => void = () => {}
    harness.generateContextSummary.mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve
      })
    )

    const a = useWorktreeContextCacheStore.getState().getOrGenerate({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1',
      branch: 'feature'
    })
    const b = useWorktreeContextCacheStore.getState().getOrGenerate({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1',
      branch: 'feature'
    })

    resolveRpc({ success: true, summary: 'shared' })
    expect(await a).toBe('shared')
    expect(await b).toBe('shared')
    expect(harness.generateContextSummary).toHaveBeenCalledTimes(1)
  })

  it('regenerates when the branch changed since the cached summary', async () => {
    harness.generateContextSummary
      .mockResolvedValueOnce({ success: true, summary: 'on main' })
      .mockResolvedValueOnce({ success: true, summary: 'on feature' })

    await useWorktreeContextCacheStore
      .getState()
      .getOrGenerate({ worktreeId: 'wt-1', worktreePath: '/repo/wt-1', branch: 'main' })
    const second = await useWorktreeContextCacheStore
      .getState()
      .getOrGenerate({ worktreeId: 'wt-1', worktreePath: '/repo/wt-1', branch: 'feature' })

    expect(second).toBe('on feature')
    expect(harness.generateContextSummary).toHaveBeenCalledTimes(2)
  })

  it('returns empty and does not cache when generation fails', async () => {
    harness.generateContextSummary.mockResolvedValue({ success: false, error: 'no binary' })

    const out = await useWorktreeContextCacheStore
      .getState()
      .getOrGenerate({ worktreeId: 'wt-1', worktreePath: '/repo/wt-1', branch: 'feature' })

    expect(out).toBe('')
    expect(useWorktreeContextCacheStore.getState().summaries['wt-1']).toBeUndefined()
  })

  it('returns empty when the RPC throws', async () => {
    harness.generateContextSummary.mockRejectedValue(new Error('boom'))

    const out = await useWorktreeContextCacheStore
      .getState()
      .getOrGenerate({ worktreeId: 'wt-1', worktreePath: '/repo/wt-1', branch: 'feature' })

    expect(out).toBe('')
  })

  it('clearSummary drops the cache so the next call regenerates', async () => {
    harness.generateContextSummary.mockResolvedValue({ success: true, summary: 'cached' })

    await useWorktreeContextCacheStore
      .getState()
      .getOrGenerate({ worktreeId: 'wt-1', worktreePath: '/repo/wt-1', branch: 'feature' })
    useWorktreeContextCacheStore.getState().clearSummary('wt-1')
    await useWorktreeContextCacheStore
      .getState()
      .getOrGenerate({ worktreeId: 'wt-1', worktreePath: '/repo/wt-1', branch: 'feature' })

    expect(harness.generateContextSummary).toHaveBeenCalledTimes(2)
  })
})
