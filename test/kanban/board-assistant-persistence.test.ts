import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  useBoardChatStore,
  type TicketDraft
} from '../../src/renderer/src/stores/useBoardChatStore'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { dbApi } from '../../src/renderer/src/api/db-api'
import { opencodeApi } from '../../src/renderer/src/api/opencode-api'
import type { Session } from '../../src/main/db/types'

vi.mock('../../src/renderer/src/api/db-api', () => ({
  dbApi: {
    session: {
      update: vi.fn(),
      delete: vi.fn()
    }
  }
}))

vi.mock('../../src/renderer/src/api/opencode-api', () => ({
  opencodeApi: {
    abort: vi.fn(),
    disconnect: vi.fn()
  }
}))

vi.mock('../../src/renderer/src/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

const projectScope = {
  kind: 'project' as const,
  projectId: 'proj-1',
  projectName: 'Project One',
  projectPath: '/tmp/proj-1'
}

const otherProjectScope = {
  kind: 'project' as const,
  projectId: 'proj-2',
  projectName: 'Project Two',
  projectPath: '/tmp/proj-2'
}

const boardDraft: TicketDraft = {
  id: 'draft-1',
  draftKey: 'draft-1',
  title: 'Create ticket',
  description: 'Persist the board assistant state',
  dependsOn: [],
  resolvedDependsOnTitles: [],
  warnings: [],
  validationIssues: [],
  projectId: 'proj-1',
  projectName: 'Project One',
  selected: true,
  createdAt: null
}

function makeBoardSession(overrides: Partial<Session> & { id: string; project_id: string }): Session {
  return {
    worktree_id: null,
    connection_id: null,
    name: 'Board Assistant',
    status: 'active',
    opencode_session_id: null,
    agent_sdk: 'opencode',
    mode: 'build',
    session_type: 'board-assistant',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-04-15T00:00:00.000Z',
    updated_at: '2026-04-15T00:00:00.000Z',
    completed_at: null,
    ...overrides
  } as Session
}

describe('board assistant persistence', () => {
  const mockSessionUpdate = vi.mocked(dbApi.session.update)
  const mockSessionDelete = vi.mocked(dbApi.session.delete)
  const mockAbort = vi.mocked(opencodeApi.abort)
  const mockDisconnect = vi.mocked(opencodeApi.disconnect)

  beforeEach(() => {
    vi.clearAllMocks()
    useBoardChatStore.setState(useBoardChatStore.getInitialState())
    useSessionStore.setState({
      boardAssistantsByProject: new Map(),
      activeBoardAssistantProjectId: null,
      activeBoardAssistantSessionId: null,
      modeBySession: new Map()
    })

    mockSessionUpdate.mockResolvedValue({ success: true })
    mockSessionDelete.mockResolvedValue(true)
    mockAbort.mockResolvedValue({ success: true, value: { success: true } })
    mockDisconnect.mockResolvedValue({ success: true, value: { success: true } })
  })

  test('restores the existing session snapshot after switching away and back', () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })
    boardChat.addLocalUserMessage('Break this into tickets')
    boardChat.setDrafts([boardDraft], 'assistant-msg-1')
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })
    boardChat.setStatus('awaiting_confirmation')

    boardChat.activateSession('board-session-2', otherProjectScope, { scope: otherProjectScope })
    boardChat.addLocalUserMessage('Different board')

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })

    const restored = useBoardChatStore.getState()
    expect(restored.sessionId).toBe('board-session-1')
    expect(restored.opencodeSessionId).toBe('opc-1')
    expect(restored.status).toBe('awaiting_confirmation')
    expect(restored.drafts).toHaveLength(1)
    expect(restored.messages.some((message) => message.content === 'Break this into tickets')).toBe(
      true
    )
    expect(restored.messages.some((message) => message.content === 'Different board')).toBe(false)
  })

  test('finds inactive session snapshots by session id', () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })

    boardChat.activateSession('board-session-2', otherProjectScope, { scope: otherProjectScope })

    const inactive = useBoardChatStore.getState().getSessionSnapshot('board-session-1')
    expect(inactive).not.toBeNull()
    expect(inactive?.scope?.kind).toBe('project')
    expect(inactive?.runtimePath).toBe('/tmp/proj-1')
  })

  test('two sessions keep independent transcripts and drafts', () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })
    boardChat.addLocalUserMessage('First chat message')
    boardChat.setDrafts([boardDraft], 'assistant-msg-1')

    boardChat.activateSession('board-session-2', projectScope, { scope: projectScope })
    boardChat.addLocalUserMessage('Second chat message')

    const first = useBoardChatStore.getState().getSessionSnapshot('board-session-1')
    const second = useBoardChatStore.getState().getSessionSnapshot('board-session-2')

    expect(first?.messages.some((m) => m.content === 'First chat message')).toBe(true)
    expect(first?.messages.some((m) => m.content === 'Second chat message')).toBe(false)
    expect(first?.drafts).toHaveLength(1)
    expect(second?.messages.some((m) => m.content === 'Second chat message')).toBe(true)
    expect(second?.messages.some((m) => m.content === 'First chat message')).toBe(false)
    expect(second?.drafts).toHaveLength(0)
  })

  test('getSnapshotsForProject returns every chat for a project', () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })
    boardChat.activateSession('board-session-2', projectScope, { scope: projectScope })
    boardChat.activateSession('board-session-3', otherProjectScope, { scope: otherProjectScope })

    const projOne = useBoardChatStore.getState().getSnapshotsForProject('proj-1')
    const projTwo = useBoardChatStore.getState().getSnapshotsForProject('proj-2')
    expect(projOne.map((s) => s.sessionId).sort()).toEqual(['board-session-1', 'board-session-2'])
    expect(projTwo.map((s) => s.sessionId)).toEqual(['board-session-3'])
  })

  test('ingesting a background snapshot does not touch the active mirror', () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })
    boardChat.activateSession('board-session-2', projectScope, { scope: projectScope })

    // board-session-2 is active; ingest a transcript for the background chat.
    boardChat.setRuntimeSessionForSession('board-session-1', {
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1',
      scope: projectScope
    })
    boardChat.ingestTranscriptForSession(
      'board-session-1',
      [
        {
          id: 'm-bg-1',
          role: 'user',
          content: 'Background chat update',
          timestamp: 1
        } as never
      ],
      false
    )

    const mirror = useBoardChatStore.getState()
    // Mirror still reflects the active chat, not the background ingest.
    expect(mirror.sessionId).toBe('board-session-2')
    expect(mirror.messages.some((m) => m.content === 'Background chat update')).toBe(false)
    // Background snapshot received the update.
    const background = mirror.getSessionSnapshot('board-session-1')
    expect(background?.messages.some((m) => m.content === 'Background chat update')).toBe(true)
  })

  test('closing an active board assistant deletes the runtime session', async () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })

    await boardChat.close()

    expect(mockDisconnect).toHaveBeenCalledWith('/tmp/proj-1', 'opc-1')
    expect(mockSessionDelete).toHaveBeenCalledWith('board-session-1')
    expect(useBoardChatStore.getState().sessionId).toBeNull()
  })

  test('closing an unfocused board assistant clears only that chat snapshot', async () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateSession('board-session-1', projectScope, { scope: projectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })

    boardChat.activateSession('board-session-2', otherProjectScope, { scope: otherProjectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-2',
      opencodeSessionId: 'opc-2',
      runtimePath: '/tmp/proj-2'
    })

    useSessionStore.setState({
      boardAssistantsByProject: new Map([
        ['proj-1', [makeBoardSession({ id: 'board-session-1', project_id: 'proj-1', opencode_session_id: 'opc-1' })]]
      ]),
      modeBySession: new Map([['board-session-1', 'build']])
    })

    const result = await useSessionStore.getState().closeBoardAssistantSession('board-session-1')

    expect(result.success).toBe(true)
    expect(useBoardChatStore.getState().getSnapshotsForProject('proj-1')).toHaveLength(0)
    expect(useBoardChatStore.getState().getSnapshotsForProject('proj-2')).toHaveLength(1)
    expect(mockAbort).toHaveBeenCalledWith('/tmp/proj-1', 'opc-1')
    expect(mockDisconnect).toHaveBeenCalledWith('/tmp/proj-1', 'opc-1')
    expect(mockSessionUpdate).toHaveBeenCalledWith('board-session-1', {
      status: 'completed',
      completed_at: expect.any(String)
    })
    expect(useSessionStore.getState().boardAssistantsByProject.has('proj-1')).toBe(false)
  })

  test('creating twice yields two distinct sessions with no reuse', async () => {
    const created: string[] = []
    mockSessionUpdate.mockResolvedValue({ success: true })
    // dbApi.session.create is needed by createBoardAssistantSession.
    ;(dbApi.session as unknown as { create: ReturnType<typeof vi.fn> }).create = vi
      .fn()
      .mockImplementation(async (input: { name?: string }) => {
        const id = `board-session-${created.length + 1}`
        created.push(id)
        return makeBoardSession({ id, project_id: 'proj-1', name: input.name ?? 'Board Assistant' })
      })

    const first = await useSessionStore.getState().createBoardAssistantSession('proj-1')
    const second = await useSessionStore.getState().createBoardAssistantSession('proj-1')

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(first.session?.id).not.toBe(second.session?.id)
    const chats = useSessionStore.getState().boardAssistantsByProject.get('proj-1') ?? []
    expect(chats).toHaveLength(2)
    // Second chat is named by index, first keeps the bare name.
    expect(chats[0].name).toBe('Board Assistant')
    expect(chats[1].name).toBe('Board Assistant 2')
    // Focus points at the most recently created chat.
    expect(useSessionStore.getState().activeBoardAssistantSessionId).toBe(second.session?.id)
  })

  test('default name derives from the highest existing suffix, never colliding with a survivor', async () => {
    // Simulate the post-close state: the bare "Board Assistant" was closed, so
    // only "Board Assistant 2" remains. The next chat must be "Board Assistant 3",
    // not "Board Assistant 2" (which array-length naming would have produced).
    useSessionStore.setState({
      boardAssistantsByProject: new Map([
        ['proj-1', [makeBoardSession({ id: 'board-session-2', project_id: 'proj-1', name: 'Board Assistant 2' })]]
      ])
    })
    ;(dbApi.session as unknown as { create: ReturnType<typeof vi.fn> }).create = vi
      .fn()
      .mockImplementation(async (input: { name?: string }) =>
        makeBoardSession({ id: 'board-session-3', project_id: 'proj-1', name: input.name ?? 'Board Assistant' })
      )

    const result = await useSessionStore.getState().createBoardAssistantSession('proj-1')

    expect(result.success).toBe(true)
    expect(result.session?.name).toBe('Board Assistant 3')
    const names = (useSessionStore.getState().boardAssistantsByProject.get('proj-1') ?? []).map(
      (s) => s.name
    )
    expect(names).toEqual(['Board Assistant 2', 'Board Assistant 3'])
    expect(new Set(names).size).toBe(names.length)
  })

  test('updateSessionName refreshes the board assistant tab label', async () => {
    useSessionStore.setState({
      boardAssistantsByProject: new Map([
        ['proj-1', [makeBoardSession({ id: 'board-session-1', project_id: 'proj-1', name: 'Board Assistant' })]]
      ])
    })
    mockSessionUpdate.mockResolvedValue(
      makeBoardSession({ id: 'board-session-1', project_id: 'proj-1', name: 'Renamed Chat' })
    )

    await useSessionStore.getState().updateSessionName('board-session-1', 'Renamed Chat')

    expect(useSessionStore.getState().boardAssistantsByProject.get('proj-1')?.[0]?.name).toBe(
      'Renamed Chat'
    )
  })

  test('switching to a connection session clears any focused board assistant', () => {
    useSessionStore.setState({
      activeConnectionId: 'conn-1',
      activeBoardAssistantProjectId: 'proj-1',
      activeBoardAssistantSessionId: 'board-session-1'
    })

    useSessionStore.getState().setActiveConnectionSession('regular-session-1')

    expect(useSessionStore.getState().activeSessionId).toBe('regular-session-1')
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBeNull()
    expect(useSessionStore.getState().activeBoardAssistantSessionId).toBeNull()
  })

  test('closing the focused chat re-points focus to a survivor', async () => {
    useSessionStore.setState({
      boardAssistantsByProject: new Map([
        [
          'proj-1',
          [
            makeBoardSession({ id: 'board-session-1', project_id: 'proj-1', opencode_session_id: 'opc-1' }),
            makeBoardSession({ id: 'board-session-2', project_id: 'proj-1', opencode_session_id: 'opc-2' })
          ]
        ]
      ]),
      activeBoardAssistantProjectId: 'proj-1',
      activeBoardAssistantSessionId: 'board-session-1',
      modeBySession: new Map([
        ['board-session-1', 'build'],
        ['board-session-2', 'build']
      ])
    })

    const result = await useSessionStore.getState().closeBoardAssistantSession('board-session-1')
    expect(result.success).toBe(true)
    expect(useSessionStore.getState().activeBoardAssistantSessionId).toBe('board-session-2')
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBe('proj-1')
    const chats = useSessionStore.getState().boardAssistantsByProject.get('proj-1') ?? []
    expect(chats.map((s) => s.id)).toEqual(['board-session-2'])
  })

  test('setOpenCodeSessionId updates board assistant sessions in the session store', () => {
    useSessionStore.setState({
      boardAssistantsByProject: new Map([
        ['proj-1', [makeBoardSession({ id: 'board-session-1', project_id: 'proj-1', opencode_session_id: 'pending::1' })]]
      ])
    })

    useSessionStore.getState().setOpenCodeSessionId('board-session-1', 'materialized-1')

    expect(
      useSessionStore.getState().boardAssistantsByProject.get('proj-1')?.[0]?.opencode_session_id
    ).toBe('materialized-1')
  })
})
