import { create } from 'zustand'
import type { KanbanTicket } from '../../../main/db/types'
import type { OpenCodeMessage } from '@/components/sessions/SessionView'
import {
  parseBoardAssistantDraftSet,
  removeBoardDraftBlocks,
  hasBoardDraftBlock
} from '@/lib/board-assistant-drafts'
import type { SelectedModel } from '@/stores/useSettingsStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { BOARD_ASSISTANT_SESSION_NAME_PREFIX } from '@/stores/useSessionStore'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { kanbanApi } from '@/api/kanban-api'
import { createTicketsFromDrafts } from '@/lib/create-tickets-from-drafts'
import { buildConditionGateConfig, isReviewGateDraft } from '@/lib/ticket-lifecycle'
import type { Attachment, AttachmentInput } from '@/components/sessions/AttachmentPreview'
import { buildDisplayContent, MAX_ATTACHMENTS } from '@/lib/file-attachment-utils'
import { parseUserMessageAttachments } from '@/lib/parse-user-message-attachments'
import { toast } from '@/lib/toast'

export type BoardChatStatus = 'idle' | 'starting' | 'thinking' | 'awaiting_confirmation' | 'error'

export type BoardChatScope =
  | {
      kind: 'project'
      projectId: string
      projectName: string
      projectPath: string
    }
  | {
      kind: 'connection'
      connectionId: string
      connectionName: string
      connectionPath: string
      availableProjects: Array<{ id: string; name: string }>
    }
  | {
      kind: 'pinned'
    }

export interface BoardChatMessage extends OpenCodeMessage {
  kind: 'transcript' | 'local'
}

export interface TicketDraft {
  id: string
  draftKey: string
  title: string
  description: string | null
  dependsOn: string[]
  resolvedDependsOnTitles: string[]
  warnings: string[]
  validationIssues: string[]
  projectId: string
  projectName: string
  selected: boolean
  createdAt: string | null
}

interface ResetBoardChatOptions {
  preserveOpen?: boolean
  scope?: BoardChatScope | null
  selectedTargetProjectId?: string | null
  selectedAgentSdkOverride?: 'opencode' | 'claude-code' | 'codex' | null
  selectedModelOverride?: SelectedModel | null
}

export interface BoardChatSnapshot {
  scope: BoardChatScope | null
  messages: BoardChatMessage[]
  drafts: TicketDraft[]
  createdDraftIds: string[]
  draftSourceMessageId: string | null
  status: BoardChatStatus
  selectedTargetProjectId: string | null
  error: string | null
  sessionId: string | null
  opencodeSessionId: string | null
  runtimePath: string | null
  selectedAgentSdkOverride: 'opencode' | 'claude-code' | 'codex' | null
  selectedModelOverride: SelectedModel | null
  composerValue: string
  composerAttachments: Attachment[]
  revertMessageID: string | null
  isEditingMessage: boolean
  editingMessageContent: string | null
}

interface BoardChatState extends BoardChatSnapshot {
  isOpen: boolean
  isMinimized: boolean
  // Snapshots are keyed by hive sessionId — N board-assistant chats may coexist
  // per project, each its own snapshot. The top-level mirror reflects the
  // currently focused (active) chat.
  activeSessionId: string | null
  snapshots: Record<string, BoardChatSnapshot>
  open: () => void
  minimize: () => void
  restore: () => void
  close: () => Promise<void>
  clear: () => Promise<void>
  activateSession: (
    sessionId: string,
    scope?: BoardChatScope | null,
    options?: ResetBoardChatOptions
  ) => void
  getSnapshotsForProject: (projectId: string) => BoardChatSnapshot[]
  getSessionSnapshot: (sessionId: string) => BoardChatSnapshot | null
  clearSessionSnapshot: (sessionId: string) => void
  resetForBoardExit: () => Promise<void>
  syncTranscript: (messages: OpenCodeMessage[], isStreaming: boolean) => void
  // Router-facing per-session actions: write a specific session's snapshot and
  // only touch the top-level mirror when that session is the active one.
  seedSessionSnapshot: (sessionId: string, scope: BoardChatScope | null) => void
  ingestTranscriptForSession: (
    sessionId: string,
    messages: OpenCodeMessage[],
    isStreaming: boolean
  ) => void
  setRuntimeSessionForSession: (
    sessionId: string,
    runtime: { opencodeSessionId: string; runtimePath: string; scope?: BoardChatScope | null }
  ) => void
  updateOpencodeSessionIdForSession: (sessionId: string, opencodeSessionId: string) => void
  sendMessage: (message: string) => Promise<void>
  createSelected: () => Promise<void>
  toggleDraftSelected: (draftId: string) => void
  markDraftsCreated: (draftIds: string[]) => void
  setSelectedTargetProjectId: (projectId: string | null) => Promise<void>
  setSelectedAgentSdkOverride: (sdk: 'opencode' | 'claude-code' | 'codex' | null) => void
  setSelectedModelOverride: (model: SelectedModel | null) => void

  openDrawer: () => void
  minimizeDrawer: () => void
  restoreDrawer: () => void
  setTranscriptMessages: (messages: OpenCodeMessage[]) => void
  addLocalUserMessage: (content: string, attachments?: Attachment[]) => void
  addLocalSystemMessage: (content: string) => void
  setDrafts: (drafts: TicketDraft[], sourceMessageId: string) => void
  clearDrafts: () => void
  setAllDraftsSelected: (selected: boolean) => void
  setStatus: (status: BoardChatStatus) => void
  setError: (error: string | null) => void
  setRuntimeSession: (runtime: {
    sessionId: string
    opencodeSessionId: string
    runtimePath: string
  }) => void
  updateOpencodeSessionId: (opencodeSessionId: string) => void
  clearRuntimeSession: () => void
  setComposerValue: (value: string) => void
  addComposerAttachment: (input: AttachmentInput) => void
  removeComposerAttachment: (id: string) => void
  clearComposerAttachments: () => void
  setRevertMessageID: (revertMessageID: string | null) => void
  setIsEditingMessage: (isEditingMessage: boolean) => void
  setEditingMessageContent: (editingMessageContent: string | null) => void
  resetState: (options?: ResetBoardChatOptions) => void
}

export function resolveBoardChatAgentSdk(
  defaultAgentSdk:
    | ReturnType<typeof useSettingsStore.getState>['defaultAgentSdk']
    | null
    | undefined
): 'opencode' | 'claude-code' | 'codex' {
  const sdk = defaultAgentSdk ?? 'opencode'
  if (sdk === 'terminal') return 'opencode'
  if (sdk === 'claude-code-cli') return 'claude-code'
  return sdk
}

export function resolveBoardChatDefaultModel(
  settings: Pick<
    ReturnType<typeof useSettingsStore.getState>,
    'defaultAgentSdk' | 'selectedModel' | 'selectedModelByProvider' | 'getModelForMode'
  >,
  agentSdkOverride?: 'opencode' | 'claude-code' | 'codex' | null
): SelectedModel | null {
  const agentSdk = agentSdkOverride ?? resolveBoardChatAgentSdk(settings.defaultAgentSdk)
  return (
    settings.getModelForMode('ask') ??
    resolveModelForSdk(agentSdk, settings) ??
    settings.selectedModel
  )
}

const BOARD_RULES_TAG_RE = /<board-assistant-rules>[\s\S]*?<\/board-assistant-rules>/gi
const BOARD_CONTEXT_TAG_RE = /<board-assistant-context>[\s\S]*?<\/board-assistant-context>/gi

export const BOARD_DRAFT_PARSE_ERROR =
  'The assistant proposed ticket drafts, but they could not be read (invalid draft format). Ask it to resend the drafts.'

export function stripBoardAssistantScaffolding(content: string): string {
  const withoutTags = content.replace(BOARD_RULES_TAG_RE, '').replace(BOARD_CONTEXT_TAG_RE, '')

  const marker = 'User request:'
  const markerIndex = withoutTags.lastIndexOf(marker)
  if (markerIndex >= 0) {
    return withoutTags.slice(markerIndex + marker.length).trim()
  }

  return withoutTags.trim()
}

export function stripBoardDraftBlocks(content: string): string {
  return removeBoardDraftBlocks(content).trim()
}

function normalizeVisibleContent(content: string, role: OpenCodeMessage['role']): string {
  const visible =
    role === 'user'
      ? stripBoardAssistantScaffolding(content)
      : stripBoardDraftBlocks(stripBoardAssistantScaffolding(content))

  // Strip attachment XML blocks (data-attachment, attached_files, ...) so an
  // optimistic local message and its transcript echo normalize to the same key
  // and dedupe, regardless of how each side encodes the attachments.
  const withoutAttachments = parseUserMessageAttachments(visible).cleanText

  return withoutAttachments.replace(/\s+/g, ' ').trim().toLowerCase()
}

function mergeTranscriptMessages(
  currentMessages: BoardChatMessage[],
  transcriptMessages: OpenCodeMessage[]
): BoardChatMessage[] {
  const normalizedTranscriptKeys = new Set(
    transcriptMessages.map(
      (message) => `${message.role}:${normalizeVisibleContent(message.content, message.role)}`
    )
  )

  const localMessages = currentMessages.filter((message) => {
    if (message.kind !== 'local') return false
    if (message.role !== 'user') return true

    const key = `${message.role}:${normalizeVisibleContent(message.content, message.role)}`
    return !normalizedTranscriptKeys.has(key)
  })

  return [
    ...localMessages,
    ...transcriptMessages.map((message) => ({
      ...message,
      kind: 'transcript' as const
    }))
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

function makeLocalMessage(
  role: OpenCodeMessage['role'],
  content: string,
  attachments?: Attachment[]
): BoardChatMessage {
  // Encode attachments into the message content as XML blocks so UserBubble
  // renders thumbnails/cards exactly the way it does for transcript messages.
  const finalContent =
    attachments && attachments.length > 0 ? buildDisplayContent(attachments, content) : content
  return {
    id: `board-chat-${role}-${crypto.randomUUID()}`,
    role,
    content: finalContent,
    timestamp: new Date().toISOString(),
    kind: 'local'
  }
}

function buildDefaultTargetProjectId(scope: BoardChatScope | null): string | null {
  if (!scope) return null
  if (scope.kind === 'project') return scope.projectId
  if (scope.kind === 'connection') return scope.availableProjects[0]?.id ?? null
  return null
}

function createInitialSnapshot(options?: ResetBoardChatOptions): BoardChatSnapshot {
  const scope = options?.scope ?? null
  return {
    scope,
    messages: [],
    drafts: [],
    createdDraftIds: [],
    draftSourceMessageId: null,
    status: 'idle',
    selectedTargetProjectId: options?.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope),
    error: null,
    sessionId: null,
    opencodeSessionId: null,
    runtimePath: null,
    selectedAgentSdkOverride: options?.selectedAgentSdkOverride ?? null,
    selectedModelOverride: options?.selectedModelOverride ?? null,
    composerValue: '',
    composerAttachments: [],
    revertMessageID: null,
    isEditingMessage: false,
    editingMessageContent: null
  }
}

function getSnapshotFromState(state: BoardChatState): BoardChatSnapshot {
  return {
    scope: state.scope,
    messages: state.messages,
    drafts: state.drafts,
    createdDraftIds: state.createdDraftIds,
    draftSourceMessageId: state.draftSourceMessageId,
    status: state.status,
    selectedTargetProjectId: state.selectedTargetProjectId,
    error: state.error,
    sessionId: state.sessionId,
    opencodeSessionId: state.opencodeSessionId,
    runtimePath: state.runtimePath,
    selectedAgentSdkOverride: state.selectedAgentSdkOverride,
    selectedModelOverride: state.selectedModelOverride,
    composerValue: state.composerValue,
    composerAttachments: state.composerAttachments,
    revertMessageID: state.revertMessageID,
    isEditingMessage: state.isEditingMessage,
    editingMessageContent: state.editingMessageContent
  }
}

function replaceActiveSnapshot(
  state: BoardChatState,
  snapshot: BoardChatSnapshot,
  activeSessionId: string | null = snapshot.sessionId ?? state.activeSessionId,
  options?: { dropExistingSnapshot?: boolean }
): Partial<BoardChatState> {
  const nextSnapshots = { ...state.snapshots }
  if (activeSessionId) {
    if (options?.dropExistingSnapshot) {
      delete nextSnapshots[activeSessionId]
    } else {
      nextSnapshots[activeSessionId] = snapshot
    }
  }

  return {
    ...snapshot,
    activeSessionId,
    snapshots: nextSnapshots
  }
}

function patchActiveSnapshot(
  state: BoardChatState,
  patch: Partial<BoardChatSnapshot>
): Partial<BoardChatState> {
  const activeSessionId = state.activeSessionId
  const nextSnapshot = {
    ...getSnapshotFromState(state),
    ...patch
  }

  const nextSnapshots = { ...state.snapshots }
  if (activeSessionId) {
    nextSnapshots[activeSessionId] = nextSnapshot
  }

  return {
    ...patch,
    snapshots: nextSnapshots
  }
}

// Write a SPECIFIC session's snapshot. Used by the background stream router so
// non-focused chats update live without touching the active mirror. Only when
// the patched session IS the active one do we also update the top-level mirror.
function patchSessionSnapshot(
  state: BoardChatState,
  sessionId: string,
  patch: Partial<BoardChatSnapshot>
): Partial<BoardChatState> {
  const base = state.snapshots[sessionId] ?? createInitialSnapshot()
  const nextSnapshot: BoardChatSnapshot = { ...base, ...patch, sessionId }
  const nextSnapshots = { ...state.snapshots, [sessionId]: nextSnapshot }

  if (sessionId === state.activeSessionId) {
    return { ...patch, sessionId, snapshots: nextSnapshots }
  }

  return { snapshots: nextSnapshots }
}

function createBaseState(): Omit<
  BoardChatState,
  | 'open'
  | 'minimize'
  | 'restore'
  | 'close'
  | 'clear'
  | 'activateSession'
  | 'getSnapshotsForProject'
  | 'getSessionSnapshot'
  | 'clearSessionSnapshot'
  | 'resetForBoardExit'
  | 'syncTranscript'
  | 'seedSessionSnapshot'
  | 'ingestTranscriptForSession'
  | 'setRuntimeSessionForSession'
  | 'updateOpencodeSessionIdForSession'
  | 'sendMessage'
  | 'createSelected'
  | 'toggleDraftSelected'
  | 'markDraftsCreated'
  | 'setSelectedTargetProjectId'
  | 'setSelectedAgentSdkOverride'
  | 'setSelectedModelOverride'
  | 'openDrawer'
  | 'minimizeDrawer'
  | 'restoreDrawer'
  | 'setTranscriptMessages'
  | 'addLocalUserMessage'
  | 'addLocalSystemMessage'
  | 'setDrafts'
  | 'clearDrafts'
  | 'setAllDraftsSelected'
  | 'setStatus'
  | 'setError'
  | 'setRuntimeSession'
  | 'updateOpencodeSessionId'
  | 'clearRuntimeSession'
  | 'setComposerValue'
  | 'addComposerAttachment'
  | 'removeComposerAttachment'
  | 'clearComposerAttachments'
  | 'setRevertMessageID'
  | 'setIsEditingMessage'
  | 'setEditingMessageContent'
  | 'resetState'
> {
  return {
    isOpen: false,
    isMinimized: false,
    activeSessionId: null,
    snapshots: {},
    ...createInitialSnapshot()
  }
}

function applyCreatedDraftState(drafts: TicketDraft[], createdDraftIds: string[]): TicketDraft[] {
  const createdDraftIdSet = new Set(createdDraftIds)
  return drafts.map((draft) =>
    createdDraftIdSet.has(draft.id)
      ? {
          ...draft,
          createdAt: draft.createdAt ?? new Date().toISOString()
        }
      : draft
  )
}

function getProjectName(scope: BoardChatScope | null, projectId: string): string {
  if (!scope) return 'Unknown project'
  if (scope.kind === 'project') return scope.projectName
  if (scope.kind === 'connection') {
    return (
      scope.availableProjects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
    )
  }
  return 'Pinned projects'
}

function parseDraftsFromMessage(
  message: OpenCodeMessage,
  scope: BoardChatScope | null,
  selectedTargetProjectId: string | null
): TicketDraft[] | null {
  const strictProjectId = scope?.kind === 'project' ? scope.projectId : null
  const fallbackProjectId = strictProjectId ?? selectedTargetProjectId
  const parsed = parseBoardAssistantDraftSet(message.content, {
    fallbackProjectId,
    strictProjectId,
    requireExplicitDraftKeys: scope?.kind === 'project'
  })
  if (!parsed) return null

  const drafts = parsed.drafts.map((draft) => ({
    id: `${message.id}:${draft.draftKey}:${strictProjectId ?? draft.projectId}`,
    draftKey: draft.draftKey,
    title: draft.title,
    description: draft.description,
    dependsOn: draft.dependsOn,
    resolvedDependsOnTitles: [] as string[],
    warnings: draft.warnings,
    validationIssues: [...draft.validationIssues],
    projectId: strictProjectId ?? draft.projectId,
    projectName: getProjectName(scope, strictProjectId ?? draft.projectId),
    selected: true,
    createdAt: null
  }))

  const titleByDraftKey = new Map(drafts.map((draft) => [draft.draftKey, draft.title]))
  for (const draft of drafts) {
    draft.resolvedDependsOnTitles = draft.dependsOn.map(
      (dependency) => titleByDraftKey.get(dependency) ?? dependency
    )
  }

  return drafts.filter((draft) => draft.projectId.length > 0)
}

async function cleanupRuntime(
  sessionId: string | null,
  opencodeSessionId: string | null,
  runtimePath: string | null
): Promise<void> {
  try {
    if (opencodeSessionId && runtimePath) {
      unwrapEnvelope(await opencodeApi.disconnect(runtimePath, opencodeSessionId))
    }
  } catch {
    // Best effort only.
  }

  try {
    if (sessionId) {
      await dbApi.session.delete(sessionId)
    }
  } catch {
    // Best effort only.
  }
}

async function buildBoardContext(
  scope: BoardChatScope,
  selectedTargetProjectId: string | null
): Promise<string> {
  if (scope.kind === 'project') {
    const tickets = await kanbanApi.ticket.getByProject<KanbanTicket>(scope.projectId, false)
    return [
      `Single-project board: ${scope.projectName}`,
      `Target project ID: ${scope.projectId}`,
      'Current tickets:',
      ...tickets.slice(0, 50).map((ticket: KanbanTicket) => `- [${ticket.column}] ${ticket.title}`)
    ].join('\n')
  }

  if (scope.kind === 'connection') {
    const ticketGroups = await Promise.all(
      scope.availableProjects.map(async (project) => ({
        project,
        tickets: await kanbanApi.ticket.getByProject<KanbanTicket>(project.id, false)
      }))
    )

    return [
      `Connection board: ${scope.connectionName}`,
      `Target project ID for new tickets: ${selectedTargetProjectId || 'none selected'}`,
      `Projects in scope: ${scope.availableProjects.map((project) => project.name).join(', ')}`,
      ...ticketGroups.flatMap(({ project, tickets }) => [
        `${project.name}:`,
        ...tickets
          .slice(0, 20)
          .map((ticket: KanbanTicket) => `- [${ticket.column}] ${ticket.title}`)
      ])
    ].join('\n')
  }

  return 'Pinned multi-project boards are not supported.'
}

function buildAssistantPrompt(
  scope: BoardChatScope,
  selectedTargetProjectId: string | null,
  boardContext: string,
  userMessage: string
): string {
  const targetProjectId = scope.kind === 'project' ? scope.projectId : selectedTargetProjectId

  return [
    '<board-assistant-rules>',
    'You are Hive Board Assistant.',
    'Purpose: converse in order to create local kanban tickets for the current board.',
    'If you need clarification, ask one concise question and do not include draft tickets yet.',
    'When you are ready to propose tickets, include exactly one fenced code block labeled board-ticket-drafts.',
    'The block must contain strict JSON shaped like:',
    '```board-ticket-drafts',
    scope.kind === 'project'
      ? '{"drafts":[{"draftKey":"string","title":"string","description":"string|null","projectId":"string","dependsOn":["draftKey"],"warnings":["string"]}]}'
      : '{"drafts":[{"title":"string","description":"string","projectId":"string","warnings":["string"]}]}',
    '```',
    `Every proposed draft must use projectId=${targetProjectId || 'MISSING_TARGET_PROJECT'}.`,
    ...(scope.kind === 'project'
      ? [
          'For project boards, every draft must include a unique draftKey.',
          'Use dependsOn to reference other drafts by draftKey when there is a dependency.'
        ]
      : []),
    'Keep draft tickets concrete and local-only.',
    '</board-assistant-rules>',
    '<board-assistant-context>',
    boardContext,
    '</board-assistant-context>',
    `User request: ${userMessage}`
  ].join('\n')
}

async function ensureRuntime(): Promise<{
  sessionId: string
  opencodeSessionId: string
  runtimePath: string
}> {
  const state = useBoardChatStore.getState()
  const scope = state.scope

  if (!scope || scope.kind === 'pinned') {
    throw new Error('Board Assistant is unavailable for this board.')
  }

  const runtimePath = scope.kind === 'project' ? scope.projectPath : scope.connectionPath
  if (!runtimePath) {
    throw new Error('Board path is unavailable for this board.')
  }

  if (state.sessionId && state.opencodeSessionId) {
    unwrapEnvelope(
      await opencodeApi.reconnect(runtimePath, state.opencodeSessionId, state.sessionId)
    )
    return {
      sessionId: state.sessionId,
      opencodeSessionId: state.opencodeSessionId,
      runtimePath
    }
  }

  const settings = useSettingsStore.getState()
  const baseAgentSdk =
    state.selectedAgentSdkOverride ?? resolveBoardChatAgentSdk(settings.defaultAgentSdk)
  const model = state.selectedModelOverride ?? resolveBoardChatDefaultModel(settings, baseAgentSdk)
  const agentSdk = state.selectedAgentSdkOverride ?? model?.agentSdk ?? baseAgentSdk

  const projectId = scope.kind === 'project' ? scope.projectId : state.selectedTargetProjectId

  if (!projectId) {
    throw new Error('Select a target project before starting the board assistant.')
  }

  const session = await dbApi.session.create<{ id: string }>({
    worktree_id: null,
    connection_id: null,
    project_id: projectId,
    name: `${BOARD_ASSISTANT_SESSION_NAME_PREFIX} ${scope.kind === 'project' ? scope.projectName : scope.connectionName}`,
    agent_sdk: agentSdk,
    ...(model
      ? {
          model_provider_id: model.providerID,
          model_id: model.modelID,
          model_variant: model.variant ?? null
        }
      : {})
  })

  const connectResult = unwrapEnvelope(await opencodeApi.connect(runtimePath, session.id))
  if (!connectResult.success || !connectResult.sessionId) {
    await dbApi.session.delete(session.id).catch(() => {})
    throw new Error(connectResult.error || 'Failed to start board assistant session.')
  }

  await dbApi.session.update(session.id, { opencode_session_id: connectResult.sessionId })

  useBoardChatStore.setState((state) =>
    patchActiveSnapshot(state, {
      sessionId: session.id,
      opencodeSessionId: connectResult.sessionId,
      runtimePath
    })
  )

  return {
    sessionId: session.id,
    opencodeSessionId: connectResult.sessionId,
    runtimePath
  }
}

async function resetAndCleanup(
  state: Pick<BoardChatState, 'sessionId' | 'opencodeSessionId' | 'runtimePath'>
): Promise<void> {
  await cleanupRuntime(state.sessionId, state.opencodeSessionId, state.runtimePath)
}

export const useBoardChatStore = create<BoardChatState>((set, get) => ({
  ...createBaseState(),

  open: () => set({ isOpen: true, isMinimized: false }),
  minimize: () => set({ isOpen: true, isMinimized: true }),
  restore: () => set({ isOpen: true, isMinimized: false }),

  close: async () => {
    const state = get()
    const resetSnapshot = createInitialSnapshot({
      scope: state.scope,
      selectedTargetProjectId:
        state.scope?.kind === 'project' ? state.scope.projectId : state.selectedTargetProjectId,
      selectedAgentSdkOverride: state.selectedAgentSdkOverride,
      selectedModelOverride: state.selectedModelOverride
    })
    set((current) => ({
      isOpen: false,
      ...replaceActiveSnapshot(current, resetSnapshot, current.activeSessionId, {
        dropExistingSnapshot: true
      })
    }))
    await resetAndCleanup(state)
  },

  clear: async () => {
    const state = get()
    set((current) =>
      replaceActiveSnapshot(
        current,
        createInitialSnapshot({
          scope: state.scope,
          selectedTargetProjectId:
            state.scope?.kind === 'project' ? state.scope.projectId : state.selectedTargetProjectId,
          selectedAgentSdkOverride: state.selectedAgentSdkOverride,
          selectedModelOverride: state.selectedModelOverride
        }),
        current.activeSessionId
      )
    )
    await resetAndCleanup(state)
  },

  activateSession: (sessionId, scope, options) => {
    set((state) => {
      const existing = state.snapshots[sessionId]

      if (existing) {
        const nextScope = scope ?? existing.scope
        const hydrated: BoardChatSnapshot = {
          ...existing,
          scope: nextScope,
          sessionId,
          selectedTargetProjectId:
            nextScope?.kind === 'project'
              ? nextScope.projectId
              : (existing.selectedTargetProjectId ?? buildDefaultTargetProjectId(nextScope))
        }
        return replaceActiveSnapshot(state, hydrated, sessionId)
      }

      return replaceActiveSnapshot(
        state,
        {
          ...createInitialSnapshot({
            ...options,
            scope: scope ?? null,
            selectedTargetProjectId:
              options?.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope ?? null)
          }),
          sessionId
        },
        sessionId
      )
    })
  },

  getSnapshotsForProject: (projectId) => {
    const state = get()
    return Object.values(state.snapshots).filter(
      (snapshot) => snapshot.scope?.kind === 'project' && snapshot.scope.projectId === projectId
    )
  },

  getSessionSnapshot: (sessionId) => {
    if (!sessionId) return null
    // snapshots[activeSessionId] is kept in sync with the mirror by
    // patchActiveSnapshot/replaceActiveSnapshot, so a direct lookup is correct
    // for both the focused chat and background chats.
    return get().snapshots[sessionId] ?? null
  },

  clearSessionSnapshot: (sessionId) => {
    set((state) => {
      const nextSnapshots = { ...state.snapshots }
      delete nextSnapshots[sessionId]

      if (state.activeSessionId === sessionId) {
        return {
          ...createBaseState(),
          isOpen: state.isOpen,
          isMinimized: state.isMinimized,
          snapshots: nextSnapshots
        }
      }

      return { snapshots: nextSnapshots }
    })
  },

  seedSessionSnapshot: (sessionId, scope) => {
    set((state) => {
      const existing = state.snapshots[sessionId]
      if (existing) {
        // Fill in scope only if it's missing — never clobber a live snapshot.
        if (existing.scope || !scope) return {}
        return patchSessionSnapshot(state, sessionId, {
          scope,
          selectedTargetProjectId:
            existing.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope)
        })
      }
      const snapshot: BoardChatSnapshot = {
        ...createInitialSnapshot({
          scope,
          selectedTargetProjectId: buildDefaultTargetProjectId(scope)
        }),
        sessionId
      }
      return { snapshots: { ...state.snapshots, [sessionId]: snapshot } }
    })
  },

  setRuntimeSessionForSession: (sessionId, { opencodeSessionId, runtimePath, scope }) => {
    set((state) => {
      const existing = state.snapshots[sessionId]
      const patch: Partial<BoardChatSnapshot> = { opencodeSessionId, runtimePath }
      if (scope && !existing?.scope) {
        patch.scope = scope
        patch.selectedTargetProjectId =
          existing?.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope)
      }
      return patchSessionSnapshot(state, sessionId, patch)
    })
  },

  updateOpencodeSessionIdForSession: (sessionId, opencodeSessionId) =>
    set((state) => patchSessionSnapshot(state, sessionId, { opencodeSessionId })),

  ingestTranscriptForSession: (sessionId, messages, isStreaming) => {
    set((state) => {
      const snapshot = state.snapshots[sessionId]
      if (!snapshot) return {}

      const mergedMessages = mergeTranscriptMessages(snapshot.messages, messages)
      const latestDraftMessage = [...messages]
        .reverse()
        .find((message) => message.role === 'assistant' && hasBoardDraftBlock(message.content))
      const parsedDrafts = latestDraftMessage
        ? parseDraftsFromMessage(
            latestDraftMessage,
            snapshot.scope,
            snapshot.selectedTargetProjectId
          )
        : null
      const draftParseFailed = Boolean(latestDraftMessage) && !parsedDrafts && !isStreaming

      return patchSessionSnapshot(state, sessionId, {
        messages: mergedMessages,
        drafts:
          parsedDrafts && latestDraftMessage
            ? applyCreatedDraftState(parsedDrafts, snapshot.createdDraftIds)
            : latestDraftMessage
              ? []
              : snapshot.drafts,
        draftSourceMessageId: latestDraftMessage?.id ?? snapshot.draftSourceMessageId,
        error: draftParseFailed
          ? BOARD_DRAFT_PARSE_ERROR
          : parsedDrafts
            ? null
            : snapshot.error,
        status: isStreaming
          ? 'thinking'
          : draftParseFailed
            ? 'error'
            : parsedDrafts && parsedDrafts.length > 0
              ? 'awaiting_confirmation'
              : snapshot.status === 'error'
                ? 'error'
                : 'idle'
      })
    })
  },

  resetForBoardExit: async () => {
    const state = get()
    set({ ...createBaseState() })
    await resetAndCleanup(state)
  },

  syncTranscript: (messages, isStreaming) => {
    const mergedMessages = mergeTranscriptMessages(get().messages, messages)
    const latestDraftMessage = [...messages].reverse().find((message) => {
      return message.role === 'assistant' && hasBoardDraftBlock(message.content)
    })
    const parsedDrafts = latestDraftMessage
      ? parseDraftsFromMessage(latestDraftMessage, get().scope, get().selectedTargetProjectId)
      : null
    // A draft block is present but could not be parsed into drafts. Surface a
    // visible error instead of silently showing a blank draft state. Only flag
    // it once streaming has finished so an in-progress (partial) block does not
    // flash an error.
    const draftParseFailed = Boolean(latestDraftMessage) && !parsedDrafts && !isStreaming

    set((state) =>
      patchActiveSnapshot(state, {
        messages: mergedMessages,
        drafts:
          parsedDrafts && latestDraftMessage
            ? applyCreatedDraftState(parsedDrafts, state.createdDraftIds)
            : latestDraftMessage
              ? []
              : state.drafts,
        draftSourceMessageId: latestDraftMessage?.id ?? state.draftSourceMessageId,
        error: draftParseFailed
          ? BOARD_DRAFT_PARSE_ERROR
          : parsedDrafts
            ? null
            : state.error,
        status: isStreaming
          ? 'thinking'
          : draftParseFailed
            ? 'error'
            : parsedDrafts && parsedDrafts.length > 0
              ? 'awaiting_confirmation'
              : state.status === 'error'
                ? 'error'
                : 'idle'
      })
    )
  },

  sendMessage: async (message) => {
    const trimmed = message.trim()
    if (!trimmed) return

    const scope = get().scope
    if (!scope || scope.kind === 'pinned') {
      set((state) =>
        patchActiveSnapshot(state, {
          status: 'error',
          error: 'Board Assistant is unavailable for this board.'
        })
      )
      return
    }

    set((state) => ({
      isOpen: true,
      isMinimized: false,
      ...patchActiveSnapshot(state, {
        status: 'starting',
        error: null,
        composerValue: ''
      })
    }))
    get().addLocalUserMessage(trimmed)

    try {
      const runtime = await ensureRuntime()
      const boardContext = await buildBoardContext(scope, get().selectedTargetProjectId)
      const prompt = buildAssistantPrompt(
        scope,
        get().selectedTargetProjectId,
        boardContext,
        trimmed
      )
      set((state) => patchActiveSnapshot(state, { status: 'thinking' }))

      const result = unwrapEnvelope(
        await opencodeApi.prompt(
          runtime.runtimePath,
          runtime.opencodeSessionId,
          prompt,
          undefined,
          { codexFastMode: useSettingsStore.getState().codexFastMode }
        )
      )

      if (!result.success) {
        throw new Error(result.error || 'Failed to send board assistant prompt.')
      }
    } catch (error) {
      set((state) =>
        patchActiveSnapshot(state, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to send board assistant prompt.'
        })
      )
      get().addLocalSystemMessage('Board Assistant failed to send that message.')
    }
  },

  createSelected: async () => {
    const selectedDrafts = get().drafts.filter((draft) => draft.selected && !draft.createdAt)
    if (selectedDrafts.length === 0) {
      get().addLocalSystemMessage('All selected drafts have already been created.')
      return
    }

    set((state) => patchActiveSnapshot(state, { status: 'starting', error: null }))

    try {
      const invalidDrafts = selectedDrafts.filter((draft) => draft.validationIssues.length > 0)
      if (invalidDrafts.length > 0) {
        throw new Error('Fix draft validation issues before creating tickets.')
      }

      // When the condition gate is enabled, seed its config onto every `review`
      // draft (so the review ticket arms the two-stage gate, and each spawned
      // `review-r{R}` re-arms it) and force build mode on the whole batch — the
      // gate only arms for build tickets.
      const settings = useSettingsStore.getState()
      const conditionGateEnabled = settings.kanbanConditionGateEnabled
      const { ticketCount, dependencyCount, createdDraftIds, failures } =
        await createTicketsFromDrafts(selectedDrafts, {
          seedLifecycle: conditionGateEnabled
            ? (draft) => (isReviewGateDraft(draft) ? buildConditionGateConfig() : null)
            : undefined,
          mode: conditionGateEnabled ? 'build' : undefined
        })

      if (createdDraftIds.length > 0) {
        get().markDraftsCreated(createdDraftIds)
      }

      if (failures.length > 0) {
        const message =
          createdDraftIds.length > 0
            ? `Created ${ticketCount} ticket${ticketCount === 1 ? '' : 's'} with ${dependencyCount} dependenc${dependencyCount === 1 ? 'y' : 'ies'}, but some projects failed: ${failures.join('; ')}`
            : `Failed to create selected tickets: ${failures.join('; ')}`
        get().addLocalSystemMessage(message)
        throw new Error(message)
      }

      get().addLocalSystemMessage(
        `Created ${ticketCount} ticket${ticketCount === 1 ? '' : 's'} with ${dependencyCount} dependenc${dependencyCount === 1 ? 'y' : 'ies'}.`
      )
      set((state) => patchActiveSnapshot(state, { status: 'idle' }))
    } catch (error) {
      set((state) =>
        patchActiveSnapshot(state, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to create selected tickets.'
        })
      )
    }
  },

  toggleDraftSelected: (draftId) =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: state.drafts.map((draft) =>
          draft.id === draftId ? { ...draft, selected: !draft.selected } : draft
        )
      })
    ),

  markDraftsCreated: (draftIds) =>
    set((state) =>
      patchActiveSnapshot(state, {
        createdDraftIds: [...new Set([...state.createdDraftIds, ...draftIds])],
        drafts: state.drafts.map((draft) =>
          draftIds.includes(draft.id)
            ? { ...draft, createdAt: draft.createdAt ?? new Date().toISOString() }
            : draft
        )
      })
    ),

  setSelectedTargetProjectId: async (projectId) => {
    const state = get()
    if (state.selectedTargetProjectId === projectId) return

    set((current) =>
      replaceActiveSnapshot(
        current,
        createInitialSnapshot({
          scope: state.scope,
          selectedTargetProjectId: projectId,
          selectedAgentSdkOverride: state.selectedAgentSdkOverride,
          selectedModelOverride: state.selectedModelOverride
        }),
        current.activeSessionId
      )
    )
    await resetAndCleanup(state)
  },

  setSelectedAgentSdkOverride: (selectedAgentSdkOverride) =>
    set((state) => patchActiveSnapshot(state, { selectedAgentSdkOverride })),

  setSelectedModelOverride: (selectedModelOverride) =>
    set((state) => patchActiveSnapshot(state, { selectedModelOverride })),

  openDrawer: () => get().open(),
  minimizeDrawer: () => get().minimize(),
  restoreDrawer: () => get().restore(),

  setTranscriptMessages: (messages) => get().syncTranscript(messages, false),

  addLocalUserMessage: (content, attachments) =>
    set((state) =>
      patchActiveSnapshot(state, {
        messages: [...state.messages, makeLocalMessage('user', content, attachments)]
      })
    ),

  addLocalSystemMessage: (content) =>
    set((state) =>
      patchActiveSnapshot(state, {
        messages: [...state.messages, makeLocalMessage('system', content)]
      })
    ),

  setDrafts: (drafts, sourceMessageId) =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: applyCreatedDraftState(drafts, state.createdDraftIds),
        draftSourceMessageId: sourceMessageId,
        status: drafts.length > 0 ? 'awaiting_confirmation' : 'idle'
      })
    ),

  clearDrafts: () =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: [],
        draftSourceMessageId: null,
        status: state.status === 'awaiting_confirmation' ? 'idle' : state.status
      })
    ),

  setAllDraftsSelected: (selected) =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: state.drafts.map((draft) => (draft.createdAt ? draft : { ...draft, selected }))
      })
    ),

  setStatus: (status) => set((state) => patchActiveSnapshot(state, { status })),
  setError: (error) => set((state) => patchActiveSnapshot(state, { error })),
  setRuntimeSession: ({ sessionId, opencodeSessionId, runtimePath }) =>
    set((state) => patchActiveSnapshot(state, { sessionId, opencodeSessionId, runtimePath })),
  updateOpencodeSessionId: (opencodeSessionId) =>
    set((state) => patchActiveSnapshot(state, { opencodeSessionId })),
  clearRuntimeSession: () =>
    set((state) =>
      patchActiveSnapshot(state, { sessionId: null, opencodeSessionId: null, runtimePath: null })
    ),
  setComposerValue: (composerValue) =>
    set((state) => patchActiveSnapshot(state, { composerValue })),
  addComposerAttachment: (input) =>
    set((state) => {
      if (state.composerAttachments.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return {}
      }
      return patchActiveSnapshot(state, {
        composerAttachments: [
          ...state.composerAttachments,
          { id: crypto.randomUUID(), ...input }
        ]
      })
    }),
  removeComposerAttachment: (id) =>
    set((state) =>
      patchActiveSnapshot(state, {
        composerAttachments: state.composerAttachments.filter((a) => a.id !== id)
      })
    ),
  clearComposerAttachments: () =>
    set((state) => patchActiveSnapshot(state, { composerAttachments: [] })),
  setRevertMessageID: (revertMessageID) =>
    set((state) => patchActiveSnapshot(state, { revertMessageID })),
  setIsEditingMessage: (isEditingMessage) =>
    set((state) => patchActiveSnapshot(state, { isEditingMessage })),
  setEditingMessageContent: (editingMessageContent) =>
    set((state) => patchActiveSnapshot(state, { editingMessageContent })),
  resetState: (options) =>
    set((state) =>
      replaceActiveSnapshot(
        state,
        {
          ...createInitialSnapshot(
            options ? { ...options, scope: options.scope ?? state.scope } : { scope: state.scope }
          ),
          sessionId: state.activeSessionId
        },
        state.activeSessionId
      )
    )
}))
