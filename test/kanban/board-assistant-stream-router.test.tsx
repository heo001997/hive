import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useBoardAssistantStreamRouter } from '../../src/renderer/src/hooks/useBoardAssistantStreamRouter'
import { useBoardChatStore } from '../../src/renderer/src/stores/useBoardChatStore'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { opencodeApi } from '../../src/renderer/src/api/opencode-api'
import type { Session } from '../../src/main/db/types'

vi.mock('../../src/renderer/src/api/opencode-api', () => ({
  opencodeApi: {
    onStream: vi.fn(),
    getMessages: vi.fn()
  }
}))

vi.mock('../../src/renderer/src/lib/ipc-envelope', () => ({
  unwrapEnvelope: (value: unknown) => value
}))

vi.mock('../../src/renderer/src/lib/opencode-transcript', () => ({
  mapOpencodeMessagesToSessionViewMessages: vi.fn((messages: unknown[]) => messages)
}))

vi.mock('../../src/renderer/src/api/db-api', () => ({
  dbApi: {
    session: {
      update: vi.fn(),
      delete: vi.fn()
    }
  }
}))

vi.mock('../../src/renderer/src/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

type StreamEvent = Record<string, unknown>

let streamHandler: ((event: StreamEvent) => void) | null = null

function seedRouterState(): {
  ingest: ReturnType<typeof vi.fn>
  updateOpc: ReturnType<typeof vi.fn>
} {
  const ingest = vi.fn()
  const updateOpc = vi.fn()

  // Background chat 'bg-session' has a live runtime; 'focused-session' is the
  // one the mounted view owns.
  useBoardChatStore.setState({
    snapshots: {
      'bg-session': {
        runtimePath: '/tmp/proj-1',
        opencodeSessionId: 'opc-1'
      }
    } as never,
    ingestTranscriptForSession: ingest,
    updateOpencodeSessionIdForSession: updateOpc
  } as never)

  useSessionStore.setState({
    boardAssistantsByProject: new Map([
      ['proj-1', [{ id: 'bg-session' }, { id: 'focused-session' }] as Session[]]
    ]),
    activeBoardAssistantSessionId: 'focused-session'
  } as never)

  return { ingest, updateOpc }
}

describe('useBoardAssistantStreamRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamHandler = null
    ;(opencodeApi.onStream as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (event: StreamEvent) => void) => {
        streamHandler = cb
        return () => {}
      }
    )
  })

  test('ingests a background chat transcript when it goes idle', async () => {
    const { ingest } = seedRouterState()
    const mapped = [{ role: 'assistant', content: 'done' }]
    ;(opencodeApi.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      messages: mapped
    })

    renderHook(() => useBoardAssistantStreamRouter())
    expect(streamHandler).toBeTypeOf('function')

    streamHandler?.({
      sessionId: 'bg-session',
      type: 'session.status',
      statusPayload: { type: 'idle' }
    })

    await waitFor(() => expect(ingest).toHaveBeenCalled())
    expect(opencodeApi.getMessages).toHaveBeenCalledWith('/tmp/proj-1', 'opc-1')
    expect(ingest).toHaveBeenCalledWith('bg-session', mapped, false)
  })

  test('skips the focused chat — the mounted view owns its ingestion', async () => {
    const { ingest } = seedRouterState()

    renderHook(() => useBoardAssistantStreamRouter())
    streamHandler?.({
      sessionId: 'focused-session',
      type: 'session.status',
      statusPayload: { type: 'idle' }
    })

    await Promise.resolve()
    expect(opencodeApi.getMessages).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  test('ignores sessions that are not board assistants', async () => {
    const { ingest } = seedRouterState()

    renderHook(() => useBoardAssistantStreamRouter())
    streamHandler?.({
      sessionId: 'some-worktree-session',
      type: 'session.status',
      statusPayload: { type: 'idle' }
    })

    await Promise.resolve()
    expect(opencodeApi.getMessages).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  test('persists the materialized opencode session id into the board snapshot', () => {
    const { updateOpc } = seedRouterState()

    renderHook(() => useBoardAssistantStreamRouter())
    streamHandler?.({
      sessionId: 'bg-session',
      type: 'session.materialized',
      data: { newSessionId: 'opc-new' }
    })

    expect(updateOpc).toHaveBeenCalledWith('bg-session', 'opc-new')
  })

  test('does not pull a transcript for a background chat with no runtime yet', async () => {
    const { ingest } = seedRouterState()
    // A chat created but not yet sent has no runtime IDs in its snapshot.
    useBoardChatStore.setState({ snapshots: {} } as never)
    useSessionStore.setState({
      boardAssistantsByProject: new Map([['proj-1', [{ id: 'bg-session' }] as Session[]]]),
      activeBoardAssistantSessionId: null
    } as never)

    renderHook(() => useBoardAssistantStreamRouter())
    streamHandler?.({
      sessionId: 'bg-session',
      type: 'session.status',
      statusPayload: { type: 'idle' }
    })

    await Promise.resolve()
    expect(opencodeApi.getMessages).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })
})
