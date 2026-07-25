import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  disposeTerminalLiveness,
  getTerminalLiveness,
  markTerminalAlive,
  recordTerminalLiveness,
  resetTerminalLiveness
} from '../rpc/domains/terminal-liveness'
import { makeLiveCompletionOpsRpcService } from '../rpc/domains/completion-ops'
import type { CompletionOpsDatabase } from '../rpc/domains/completion-ops'

afterEach(() => {
  resetTerminalLiveness()
})

describe('terminal liveness mirror (server process)', () => {
  it('reports nothing for a terminal it has never seen', () => {
    expect(getTerminalLiveness('t1')).toBeUndefined()
  })

  it('marks a just-created terminal alive with no bytes yet', () => {
    const before = Date.now()
    markTerminalAlive('t1')
    const live = getTerminalLiveness('t1')

    expect(live?.bytes).toBe(0)
    expect(live?.tail).toBe('')
    // A booting PTY must read as ALIVE (recent last-emit), not as a frozen session —
    // the Claude CLI takes ~300ms to paint its first frame.
    expect(live!.lastOutputAt).toBeGreaterThanOrEqual(before)
  })

  it('does not rewind a live terminal when a duplicate create marks it again', () => {
    markTerminalAlive('t1')
    recordTerminalLiveness('t1', 'hello')
    const stamped = getTerminalLiveness('t1')!

    markTerminalAlive('t1')

    expect(getTerminalLiveness('t1')).toEqual(stamped)
  })

  it('accumulates bytes and keeps an ANSI-stripped tail', () => {
    recordTerminalLiveness('t1', '\x1b[31mhel')
    recordTerminalLiveness('t1', 'lo\x1b[0m world')

    const live = getTerminalLiveness('t1')
    expect(live?.tail).toBe('hello world')
    // Bytes count the RAW stream (it only has to move while output flows).
    expect(live?.bytes).toBe('\x1b[31mhel'.length + 'lo\x1b[0m world'.length)
  })

  it('restamps lastOutputAt on every emit', async () => {
    markTerminalAlive('t1')
    const first = getTerminalLiveness('t1')!.lastOutputAt
    await new Promise((r) => setTimeout(r, 5))
    recordTerminalLiveness('t1', 'x')

    expect(getTerminalLiveness('t1')!.lastOutputAt).toBeGreaterThan(first)
  })

  it('caps the retained tail (rolling window keeps the most recent output)', () => {
    recordTerminalLiveness('t1', 'a'.repeat(20 * 1024))
    recordTerminalLiveness('t1', 'TAIL')

    const live = getTerminalLiveness('t1')!
    expect(live.tail.length).toBe(16 * 1024)
    expect(live.tail.endsWith('TAIL')).toBe(true)
    expect(live.bytes).toBe(20 * 1024 + 4)
  })

  it('forgets a terminal on dispose (exit / destroy)', () => {
    recordTerminalLiveness('t1', 'hi')
    disposeTerminalLiveness('t1')

    expect(getTerminalLiveness('t1')).toBeUndefined()
  })
})

describe('completionOps.getSessionFingerprint default liveness wiring', () => {
  const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex')

  const emptyDb = (): CompletionOpsDatabase =>
    ({
      getKanbanTicket: () => null,
      getSession: () => null,
      getWorktree: () => null,
      getSessionMessages: () => []
    }) as unknown as CompletionOpsDatabase

  // The regression this pins: the fingerprint used to default to
  // `main/services/terminal-pty-bridge`, whose accumulator lives in the Electron main
  // process — a second, permanently empty module instance from in here. Every frozen
  // check therefore degraded to the DB fallback, which for a Claude CLI session (no DB
  // messages at all) compared two identical empty samples and answered "frozen" ~1.2s
  // after ANY completed event. The 30s sustained-silence window never applied.
  it('reads the server-process mirror with no dependency injected', async () => {
    markTerminalAlive('s1')
    recordTerminalLiveness('s1', '\x1b[2mworking…\x1b[0m')
    const service = makeLiveCompletionOpsRpcService({ loadDatabase: emptyDb })

    const fp = await Effect.runPromise(service.getSessionFingerprint({ sessionId: 's1' }))

    expect(fp.source).toBe('pty')
    expect(fp.hash).toBe(sha256('working…'))
    expect(fp.lastOutputAt).toBeGreaterThan(0)
  })

  it('still falls back to the DB fingerprint when the mirror has no such terminal', async () => {
    const service = makeLiveCompletionOpsRpcService({ loadDatabase: emptyDb })

    const fp = await Effect.runPromise(service.getSessionFingerprint({ sessionId: 'gone' }))

    expect(fp.source).toBe('db')
  })
})
