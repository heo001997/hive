import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force fs.watch to be a silent no-op that never emits an event. This reproduces
// the exact failure the watcher must survive: macOS FSEvents dropping/coalescing
// the transcript's create event. With fs.watch inert, detection can ONLY succeed
// via the poll fallback — so these tests prove the poll path, not fs.watch, is
// what captures the session id.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    watch: vi.fn(() => ({ close: vi.fn() }))
  }
})

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { watch } from 'fs'
import { encodePath } from './claude-transcript-reader'
import { watchForClaudeSessionId } from './claude-session-watcher'

describe('watchForClaudeSessionId', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hive-session-watcher-'))
    vi.mocked(watch).mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tempDir, { recursive: true, force: true })
  })

  const setup = (): { worktreePath: string; transcriptDir: string } => {
    const claudeConfigDir = join(tempDir, 'claude')
    const worktreePath = join(tempDir, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir)
    const transcriptDir = join(claudeConfigDir, 'projects', encodePath(worktreePath))
    return { worktreePath, transcriptDir }
  }

  it('captures a session id from a transcript created after arming, via poll only', async () => {
    const { worktreePath, transcriptDir } = setup()
    mkdirSync(transcriptDir, { recursive: true })

    const onId = vi.fn()
    const handle = watchForClaudeSessionId(worktreePath, onId, { pollMs: 15 })

    // fs.watch is attached (low-latency path) but inert — no events ever fire.
    expect(vi.mocked(watch)).toHaveBeenCalled()

    // The transcript appears only after the initial scan; fs.watch never reports
    // it, so capture must come from the poll.
    writeFileSync(join(transcriptDir, 'sess-abc.jsonl'), '{}\n')
    await vi.waitFor(() => expect(onId).toHaveBeenCalledWith('sess-abc'), {
      timeout: 1000,
      interval: 10
    })
    expect(onId).toHaveBeenCalledTimes(1)
    handle.close()
  })

  it('detects a transcript even when the project dir does not exist at arm time', async () => {
    const { worktreePath, transcriptDir } = setup()
    // Intentionally do NOT create transcriptDir yet — brand-new worktree.

    const onId = vi.fn()
    const handle = watchForClaudeSessionId(worktreePath, onId, { pollMs: 15 })

    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(join(transcriptDir, 'later.jsonl'), '{}\n')

    await vi.waitFor(() => expect(onId).toHaveBeenCalledWith('later'), {
      timeout: 1000,
      interval: 10
    })
    // fs.watch is lazily attached once the dir appears.
    expect(vi.mocked(watch)).toHaveBeenCalled()
    handle.close()
  })

  it('ignores transcripts that already existed before arming', async () => {
    const { worktreePath, transcriptDir } = setup()
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(join(transcriptDir, 'pre-existing.jsonl'), '{}\n')

    const onId = vi.fn()
    const handle = watchForClaudeSessionId(worktreePath, onId, { pollMs: 15 })

    // Give the poll several ticks; the pre-existing file must not be reported.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(onId).not.toHaveBeenCalled()

    // A genuinely new transcript is still captured.
    writeFileSync(join(transcriptDir, 'fresh.jsonl'), '{}\n')
    await vi.waitFor(() => expect(onId).toHaveBeenCalledWith('fresh'), {
      timeout: 1000,
      interval: 10
    })
    handle.close()
  })

  it('stops detecting after close()', async () => {
    const { worktreePath, transcriptDir } = setup()
    mkdirSync(transcriptDir, { recursive: true })

    const onId = vi.fn()
    const handle = watchForClaudeSessionId(worktreePath, onId, { pollMs: 15 })
    handle.close()

    writeFileSync(join(transcriptDir, 'after-close.jsonl'), '{}\n')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(onId).not.toHaveBeenCalled()
  })
})
