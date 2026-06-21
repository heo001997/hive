import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  ArrowDown,
  Bot,
  CheckSquare,
  History,
  Pencil,
  Send,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { AssistantCanvas } from '@/components/sessions/AssistantCanvas'
import { UserBubble } from '@/components/sessions/UserBubble'
import { QuestionPrompt } from '@/components/sessions/QuestionPrompt'
import { PermissionPrompt } from '@/components/sessions/PermissionPrompt'
import { CommandApprovalPrompt } from '@/components/sessions/CommandApprovalPrompt'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { useSessionStream } from '@/hooks/useSessionStream'
import {
  parseBoardAssistantDraftSet,
  type ParsedBoardAssistantDraft,
  type ParsedBoardAssistantDraftSet
} from '@/lib/board-assistant-drafts'
import { toast } from '@/lib/toast'
import {
  useBoardChatStore,
  type BoardChatMessage,
  type BoardChatScope,
  type TicketDraft,
  stripBoardAssistantScaffolding,
  stripBoardDraftBlocks,
  resolveBoardChatAgentSdk,
  resolveBoardChatDefaultModel
} from '@/stores/useBoardChatStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useQuestionStore, type QuestionAnswer } from '@/stores/useQuestionStore'
import { useSessionStore, BOARD_TAB_ID } from '@/stores/useSessionStore'
import { useSettingsStore, type SelectedModel } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import type { StreamingPart } from '@/components/sessions/SessionView'
import type { QuestionRequest } from '@/stores/useQuestionStore'
import type { CommandApprovalRequest } from '@/stores/useCommandApprovalStore'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { kanbanApi } from '@/api/kanban-api'
import type { Worktree } from '@shared/types/worktree'
import type {
  KanbanTicketBatchCreate,
  KanbanTicketBatchCreateResult
} from '../../../../main/db/types'

interface BoardAssistantViewProps {
  projectId: string
}

type BoardAssistantAgentSdk = 'opencode' | 'claude-code' | 'codex'

function coerceBoardAssistantAgentSdk(
  sdk: SelectedModel['agentSdk'] | BoardAssistantAgentSdk | null | undefined,
  fallback: BoardAssistantAgentSdk
): BoardAssistantAgentSdk {
  if (sdk === 'opencode' || sdk === 'claude-code' || sdk === 'codex') return sdk
  return fallback
}

const BOARD_ASSISTANT_RULES = [
  'You are Hive Board Assistant.',
  'Stay focused on helping the user create local kanban tickets for the current board scope.',
  'Do not claim tickets are created. The UI will create them only after explicit confirmation.',
  'Ask concise clarifying questions when needed.',
  'When you are ready to propose tickets, append exactly one fenced code block tagged board-ticket-drafts.',
  'For project boards, the JSON schema is {"drafts":[{"draftKey":"string","title":"string","description":"string|null","projectId":"string","dependsOn":["draftKey"],"warnings":["string"]}]}.',
  'For other board scopes, the JSON schema is {"drafts":[{"title":"string","description":"string|null","warnings":["string"]}]}.',
  'When revising drafts, output a full replacement draft set in that code block.',
  'Keep titles short, specific, and implementation-ready.'
].join('\n')

function buildScopeKey(scope: BoardChatScope | null): string {
  if (!scope) return 'none'
  if (scope.kind === 'project') return `project:${scope.projectId}`
  if (scope.kind === 'connection') return `connection:${scope.connectionId}`
  return 'pinned'
}

function sanitizeBoardMessageContent(message: BoardChatMessage): string {
  const withoutScaffolding = stripBoardAssistantScaffolding(message.content)
  if (message.role === 'assistant') {
    const withoutDrafts = stripBoardDraftBlocks(withoutScaffolding)
    const parsedDrafts = parseBoardAssistantDraftSet(message.content)
    return withoutDrafts || (parsedDrafts ? 'Proposed ticket drafts below.' : withoutDrafts)
  }
  return withoutScaffolding
}

function sanitizeStreamingParts(
  parts: StreamingPart[] | undefined,
  role: BoardChatMessage['role']
): StreamingPart[] | undefined {
  if (!parts?.length) return parts

  return parts.map((part) => {
    if (part.type !== 'text') return part
    const baseText = part.text ?? ''
    const nextText =
      role === 'assistant'
        ? stripBoardDraftBlocks(stripBoardAssistantScaffolding(baseText))
        : stripBoardAssistantScaffolding(baseText)
    return { ...part, text: nextText }
  })
}

function getStatusLabel(status: ReturnType<typeof useBoardChatStore.getState>['status']): string {
  switch (status) {
    case 'starting':
      return 'Starting'
    case 'thinking':
      return 'Thinking'
    case 'awaiting_confirmation':
      return 'Drafts ready'
    case 'error':
      return 'Needs attention'
    default:
      return 'Ready'
  }
}

function getAgentSdkLabel(agentSdk: 'opencode' | 'claude-code' | 'codex'): string {
  switch (agentSdk) {
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    default:
      return 'OpenCode'
  }
}

function truncateDescription(description: string | null | undefined): string | null {
  if (!description) return null
  return description.length > 240 ? `${description.slice(0, 237)}...` : description
}

// Sentinel value for a built draft's `createdAt` when its id is already in the
// store's createdDraftIds. Only its truthiness is read (to disable/badge the
// card); these built drafts are ephemeral UI state, never persisted.
const CREATED_DRAFT_MARKER = 'created'

// Turn a parsed draft set into the rich TicketDraft[] used for ticket creation.
// Shared by the auto-activation effect (which stores the latest set as active)
// and inline creation from a historical panel's parsed set. The generated `id`
// is deterministic (messageId:draftKey:projectId) so it can be matched against
// the store's createdDraftIds to detect an already-created historical set.
function buildTicketDrafts(
  messageId: string,
  parsedDrafts: ParsedBoardAssistantDraft[],
  scope: BoardChatScope,
  targetProjectId: string,
  projects: Array<{ id: string; name: string }>
): TicketDraft[] {
  const titleByDraftKey = new Map(parsedDrafts.map((draft) => [draft.draftKey, draft.title]))
  return parsedDrafts.map((draft) => {
    const projectId = scope.kind === 'project' ? targetProjectId : draft.projectId || targetProjectId
    return {
      id: `${messageId}:${draft.draftKey}:${projectId}`,
      draftKey: draft.draftKey,
      title: draft.title,
      description: draft.description,
      dependsOn: draft.dependsOn,
      resolvedDependsOnTitles: draft.dependsOn.map(
        (dependency) => titleByDraftKey.get(dependency) ?? dependency
      ),
      warnings: draft.warnings,
      validationIssues: draft.validationIssues,
      projectId,
      projectName: projects.find((project) => project.id === projectId)?.name ?? 'Unknown project',
      selected: true,
      createdAt: null
    }
  })
}

async function resolveProjectRuntime(
  projectId: string
): Promise<{ worktreeId: string; path: string } | null> {
  const worktreeStore = useWorktreeStore.getState()
  const selectedWorktreeId = worktreeStore.selectedWorktreeId
  const projectWorktrees = worktreeStore.getWorktreesForProject(projectId)
  const selectedProjectWorktree = projectWorktrees.find(
    (worktree) => worktree.id === selectedWorktreeId
  )
  const chosenWorktree =
    selectedProjectWorktree ??
    worktreeStore.getDefaultWorktree(projectId) ??
    projectWorktrees[0] ??
    null

  if (chosenWorktree?.path) {
    return { worktreeId: chosenWorktree.id, path: chosenWorktree.path }
  }

  const fallbackWorktrees = await dbApi.worktree.getActiveByProject<Worktree>(projectId)
  const fallback =
    fallbackWorktrees.find((worktree) => worktree.is_default) ?? fallbackWorktrees[0] ?? null

  return fallback?.path ? { worktreeId: fallback.id, path: fallback.path } : null
}

function buildBoardPrompt(input: string, scope: BoardChatScope, targetProjectId: string): string {
  const projectStore = useProjectStore.getState()
  const kanbanStore = useKanbanStore.getState()
  const targetProject = projectStore.projects.find((project) => project.id === targetProjectId)
  const visibleTickets = kanbanStore
    .getTicketsForProject(targetProjectId)
    .filter((ticket) => !ticket.archived_at)
    .map((ticket) => ({
      title: ticket.title,
      description: truncateDescription(ticket.description),
      column: ticket.column
    }))
    .slice(0, 80)

  const context = {
    scope:
      scope.kind === 'project'
        ? { kind: 'project', projectName: scope.projectName }
        : scope.kind === 'connection'
          ? { kind: 'connection', connectionName: scope.connectionName }
          : { kind: 'pinned' },
    targetProject: targetProject
      ? {
          id: targetProject.id,
          name: targetProject.name,
          path: targetProject.path,
          description: targetProject.description
        }
      : { id: targetProjectId },
    existingTickets: visibleTickets
  }

  return [
    '<board-assistant-rules>',
    BOARD_ASSISTANT_RULES,
    ...(scope.kind === 'project'
      ? [
          `Every proposed draft must use projectId=${targetProjectId}.`,
          'Every proposed draft must include a unique draftKey.',
          'Use dependsOn to reference other drafts by their draftKey when there is a dependency.'
        ]
      : []),
    '</board-assistant-rules>',
    '<board-assistant-context>',
    JSON.stringify(context, null, 2),
    '</board-assistant-context>',
    '',
    'User request:',
    input
  ].join('\n')
}

async function ensureRuntimeSession(
  scope: BoardChatScope,
  targetProjectId: string
): Promise<{
  sessionId: string
  opencodeSessionId: string
  runtimePath: string
} | null> {
  const currentState = useBoardChatStore.getState()
  if (currentState.sessionId && currentState.opencodeSessionId && currentState.runtimePath) {
    return {
      sessionId: currentState.sessionId,
      opencodeSessionId: currentState.opencodeSessionId,
      runtimePath: currentState.runtimePath
    }
  }

  const settings = useSettingsStore.getState()
  const baseAgentSdk =
    currentState.selectedAgentSdkOverride ?? resolveBoardChatAgentSdk(settings.defaultAgentSdk)
  const selectedModel =
    currentState.selectedModelOverride ?? resolveBoardChatDefaultModel(settings, baseAgentSdk)
  const agentSdk = currentState.selectedAgentSdkOverride ?? selectedModel?.agentSdk ?? baseAgentSdk

  let runtimePath: string | null = null
  let worktreeId: string | null = null
  let connectionId: string | null = null

  if (scope.kind === 'project') {
    const runtime = await resolveProjectRuntime(scope.projectId)
    if (!runtime) return null
    runtimePath = runtime.path
    worktreeId = runtime.worktreeId
  } else if (scope.kind === 'connection') {
    const connection = useConnectionStore
      .getState()
      .connections.find((candidate) => candidate.id === scope.connectionId)
    if (!connection?.path) return null
    runtimePath = connection.path
    connectionId = connection.id
  } else {
    return null
  }

  // Reuse the session already created by the session store (from createBoardAssistantSession)
  // rather than creating a duplicate. Only create if none exists.
  const { useSessionStore } = await import('@/stores/useSessionStore')
  const existingStoreSession = useSessionStore
    .getState()
    .boardAssistantByProject.get(targetProjectId)

  let session: { id: string }
  const isReused = Boolean(existingStoreSession)
  if (existingStoreSession) {
    session = existingStoreSession
    // Update the existing session with the model/SDK settings
    await dbApi.session.update(session.id, {
      agent_sdk: agentSdk,
      ...(selectedModel
        ? {
            model_provider_id: selectedModel.providerID,
            model_id: selectedModel.modelID,
            model_variant: selectedModel.variant ?? null
          }
        : {})
    })
  } else {
    session = await dbApi.session.create<{ id: string }>({
      worktree_id: worktreeId,
      connection_id: connectionId,
      project_id: targetProjectId,
      name: 'Board Assistant',
      session_type: 'board-assistant',
      agent_sdk: agentSdk,
      mode: 'build',
      ...(selectedModel
        ? {
            model_provider_id: selectedModel.providerID,
            model_id: selectedModel.modelID,
            model_variant: selectedModel.variant ?? null
          }
        : {})
    })
  }

  const connectResult = unwrapEnvelope(await opencodeApi.connect(runtimePath, session.id))
  if (!connectResult.success || !connectResult.sessionId) {
    // Only delete the session if we just created it. Reused sessions
    // should be kept so the user doesn't lose the record and messages.
    if (!isReused) {
      await dbApi.session.delete(session.id).catch(() => {})
    }
    // Re-sync store so the stale entry is removed and the tab disappears
    const { useSessionStore } = await import('@/stores/useSessionStore')
    await useSessionStore.getState().loadBoardAssistantSession(targetProjectId)
    return null
  }

  await dbApi.session.update(session.id, {
    opencode_session_id: connectResult.sessionId
  })

  useBoardChatStore.getState().setRuntimeSession({
    sessionId: session.id,
    opencodeSessionId: connectResult.sessionId,
    runtimePath
  })

  return {
    sessionId: session.id,
    opencodeSessionId: connectResult.sessionId,
    runtimePath
  }
}

async function cleanupBoardChatRuntime(): Promise<void> {
  const state = useBoardChatStore.getState()
  const sessionId = state.sessionId
  const opencodeSessionId = state.opencodeSessionId
  const runtimePath = state.runtimePath

  // If the store has already been reset (e.g. closeBoardAssistantSession
  // already cleaned up), skip runtime teardown but still reset the store
  // in case partial state remains.
  if (!sessionId && !opencodeSessionId && !runtimePath) {
    useBoardChatStore.getState().resetState()
    return
  }

  if (sessionId) {
    useQuestionStore.getState().clearSession(sessionId)
    usePermissionStore.getState().clearSession(sessionId)
    useCommandApprovalStore.getState().clearSession(sessionId)
  }

  if (runtimePath && opencodeSessionId) {
    try {
      unwrapEnvelope(await opencodeApi.abort(runtimePath, opencodeSessionId))
    } catch {
      // Best effort cleanup.
    }

    try {
      unwrapEnvelope(await opencodeApi.disconnect(runtimePath, opencodeSessionId))
    } catch {
      // Best effort cleanup.
    }
  }

  // Always reset the chat store after full cleanup so callers don't
  // need to remember to call resetState() separately.
  useBoardChatStore.getState().resetState()
}

function BoardChatHeader({
  scope,
  selectedTargetProjectId,
  status,
  selectedModel,
  agentSdk,
  availableAgentSdks,
  modelResetVisible,
  onSelectAgentSdk,
  onSelectModel,
  onResetModel,
  onSelectTargetProject,
  onClear
}: {
  scope: BoardChatScope
  selectedTargetProjectId: string | null
  status: ReturnType<typeof useBoardChatStore.getState>['status']
  selectedModel: SelectedModel | null
  agentSdk: 'opencode' | 'claude-code' | 'codex'
  availableAgentSdks: Array<'opencode' | 'claude-code' | 'codex'>
  modelResetVisible: boolean
  onSelectAgentSdk: (agentSdk: 'opencode' | 'claude-code' | 'codex') => void
  onSelectModel: (model: SelectedModel) => void
  onResetModel: () => void
  onSelectTargetProject: (projectId: string) => void
  onClear: () => void
}): React.JSX.Element {
  const selectedTargetProject =
    scope.kind === 'connection'
      ? scope.availableProjects.find((project) => project.id === selectedTargetProjectId)
      : null

  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/12 text-primary">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">Board Assistant</p>
            <p className="text-xs text-muted-foreground">{getStatusLabel(status)}</p>
          </div>
        </div>

        {scope.kind === 'project' && (
          <div className="inline-flex rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
            {scope.projectName}
          </div>
        )}

        {scope.kind === 'connection' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
              {scope.connectionName}
            </div>
            <select
              value={selectedTargetProjectId ?? ''}
              onChange={(event) => onSelectTargetProject(event.target.value)}
              className="h-8 rounded-full border border-border/70 bg-background px-3 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            >
              {scope.availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {selectedTargetProject && (
              <span className="text-xs text-muted-foreground">
                Targeting {selectedTargetProject.name}
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/70"
              >
                <span>{getAgentSdkLabel(agentSdk)}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {availableAgentSdks.map((sdkOption) => (
                <DropdownMenuItem
                  key={sdkOption}
                  onClick={() => onSelectAgentSdk(sdkOption)}
                  className="cursor-pointer"
                >
                  {getAgentSdkLabel(sdkOption)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ModelSelector
            value={selectedModel}
            onChange={onSelectModel}
            agentSdkOverride={agentSdk}
            disableTitleTooltip={true}
            hideProviderPrefix={true}
          />
          {modelResetVisible && (
            <button
              type="button"
              onClick={onResetModel}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Use Default
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" onClick={onClear} aria-label="Clear chat">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function BoardChatDraftProposalCard({
  draft,
  onToggle
}: {
  draft: TicketDraft
  onToggle: (draftId: string) => void
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <Checkbox
          checked={draft.selected || Boolean(draft.createdAt)}
          onCheckedChange={() => onToggle(draft.id)}
          className="mt-1"
          disabled={Boolean(draft.createdAt)}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{draft.title}</p>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              {draft.projectName}
            </span>
            {draft.createdAt && (
              <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Created
              </span>
            )}
          </div>
          {draft.description && (
            <div className="text-sm text-muted-foreground">
              <MarkdownRenderer content={draft.description} />
            </div>
          )}
          {draft.resolvedDependsOnTitles.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium uppercase tracking-[0.14em]">Depends on</span>
              {draft.resolvedDependsOnTitles.map((dependency) => (
                <span
                  key={`${draft.id}-${dependency}`}
                  className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5"
                >
                  {dependency}
                </span>
              ))}
            </div>
          )}
          {draft.warnings.length > 0 && (
            <div className="space-y-1 rounded-xl border border-border/70 bg-muted/30 px-3 py-2">
              {draft.warnings.map((warning) => (
                <p key={warning} className="text-xs text-muted-foreground">
                  {warning}
                </p>
              ))}
            </div>
          )}
          {draft.validationIssues.length > 0 && (
            <div className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2">
              {draft.validationIssues.map((issue) => (
                <p key={issue} className="text-xs text-destructive">
                  {issue}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// A fully-interactive draft panel rendered for EVERY assistant message that
// proposes ticket drafts — there is no read-only "historical" tier. Selection
// is local to the panel, so each proposal in the transcript can be created
// (all or a chosen subset) and revised independently. Per-draft created-state
// is derived from the store's createdDraftIds (via each draft's `createdAt`),
// so it survives the view unmounting (e.g. navigateToBoard) and remounting —
// creating tickets a second time from the same panel is impossible.
//
// `isActive` marks the latest proposal (the one tracked by draftSourceMessageId):
// it gets the "Draft proposals" heading and a Cancel button that clears the
// active store slot. Older proposals get a "Previous proposals" heading and the
// same Create/Revise controls, minus Cancel (there is no active slot to clear).
function BoardChatDraftPanel({
  drafts,
  isActive,
  onCreate,
  onRevise,
  onCancel
}: {
  drafts: TicketDraft[]
  isActive: boolean
  onCreate: (draftsToCreate: TicketDraft[]) => Promise<boolean>
  onRevise: (drafts: TicketDraft[]) => void
  onCancel: () => void
}): React.JSX.Element {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(drafts.filter((draft) => !draft.createdAt).map((draft) => draft.id))
  )
  const [creating, setCreating] = useState(false)

  const toggleDraft = (draftId: string): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(draftId)) next.delete(draftId)
      else next.add(draftId)
      return next
    })
  }

  const dependencyCount = drafts.reduce((count, draft) => count + draft.dependsOn.length, 0)
  const invalidDraftCount = drafts.filter((draft) => draft.validationIssues.length > 0).length
  const hasInvalidDrafts = invalidDraftCount > 0
  const creatableDrafts = drafts.filter((draft) => !draft.createdAt)
  const allCreated = drafts.length > 0 && creatableDrafts.length === 0
  const selectedCreatableDrafts = creatableDrafts.filter((draft) => selectedIds.has(draft.id))
  const decoratedDrafts = drafts.map((draft) => ({ ...draft, selected: selectedIds.has(draft.id) }))

  const runCreate = async (draftsToCreate: TicketDraft[]): Promise<void> => {
    if (creating || draftsToCreate.length === 0) return
    setCreating(true)
    try {
      await onCreate(draftsToCreate)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className={
        isActive
          ? 'space-y-3 rounded-3xl border border-border/70 bg-muted/20 p-3'
          : 'space-y-3 rounded-3xl border border-dashed border-border/60 bg-muted/10 p-3'
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {isActive ? <Sparkles className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
          {isActive ? 'Draft proposals' : 'Previous proposals'}
        </div>
        {!isActive && (
          <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Historical
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{drafts.length} drafts</span>
        <span>
          {dependencyCount} dependenc{dependencyCount === 1 ? 'y' : 'ies'}
        </span>
        {invalidDraftCount > 0 && (
          <span className="text-destructive">{invalidDraftCount} invalid</span>
        )}
      </div>
      <div className="space-y-2">
        {decoratedDrafts.map((draft) => (
          <BoardChatDraftProposalCard key={draft.id} draft={draft} onToggle={toggleDraft} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void runCreate(creatableDrafts)
          }}
          disabled={hasInvalidDrafts || creating || allCreated}
        >
          {allCreated ? 'Created' : creating ? 'Creating…' : 'Create all'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void runCreate(selectedCreatableDrafts)
          }}
          disabled={hasInvalidDrafts || creating || selectedCreatableDrafts.length === 0}
        >
          <CheckSquare className="h-4 w-4" />
          Create selected
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onRevise(drafts)}>
          Revise with AI
        </Button>
        {isActive && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Dismiss
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {hasInvalidDrafts
            ? 'Fix validation issues first'
            : allCreated
              ? 'All tickets created'
              : `${selectedCreatableDrafts.length}/${creatableDrafts.length} selected`}
        </span>
      </div>
    </div>
  )
}

function BoardChatMessageList({
  messages,
  drafts,
  draftSourceMessageId,
  streamingMessage,
  activeQuestion,
  activePermission,
  activeApproval,
  sessionId,
  editableMessageId,
  onEditMessage,
  buildDraftsForMessage,
  onCreate,
  onRevise,
  onCancelDrafts,
  onQuestionReply,
  onQuestionReject,
  onPermissionReply,
  onCommandApprovalReply
}: {
  messages: BoardChatMessage[]
  drafts: TicketDraft[]
  draftSourceMessageId: string | null
  streamingMessage: BoardChatMessage | null
  activeQuestion: QuestionRequest | null
  activePermission: PermissionRequest | null
  activeApproval: CommandApprovalRequest | null
  sessionId: string | null
  editableMessageId: string | null
  onEditMessage: (content: string) => void
  buildDraftsForMessage: (parsed: ParsedBoardAssistantDraftSet, messageId: string) => TicketDraft[]
  onCreate: (draftsToCreate: TicketDraft[]) => Promise<boolean>
  onRevise: (drafts: TicketDraft[]) => void
  onCancelDrafts: () => void
  onQuestionReply: (requestId: string, answers: QuestionAnswer[]) => void
  onQuestionReject: (requestId: string) => void
  onPermissionReply: (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    message?: string
  ) => void
  onCommandApprovalReply: (
    requestId: string,
    approved: boolean,
    remember?: 'allow' | 'block',
    pattern?: string,
    patterns?: string[]
  ) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const userHasScrolledUpRef = useRef(false)
  const [userHasScrolledUp, setUserHasScrolledUp] = useState(false)

  const isNearBottom = (): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      const scrolledUp = !isNearBottom()
      userHasScrolledUpRef.current = scrolledUp
      setUserHasScrolledUp(scrolledUp)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (userHasScrolledUpRef.current) return
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [
    messages,
    drafts,
    draftSourceMessageId,
    streamingMessage,
    activeQuestion,
    activePermission,
    activeApproval
  ])

  return (
    <div ref={scrollRef} className="relative flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((message) => {
        if (message.role === 'system') {
          return (
            <div
              key={message.id}
              className="rounded-2xl border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground"
            >
              {message.content}
            </div>
          )
        }

        const parsedDrafts =
          message.role === 'assistant' ? parseBoardAssistantDraftSet(message.content) : null
        const messageDrafts =
          parsedDrafts && parsedDrafts.drafts.length > 0
            ? buildDraftsForMessage(parsedDrafts, message.id)
            : []
        const sanitizedContent = sanitizeBoardMessageContent(message)
        const sanitizedParts = sanitizeStreamingParts(message.parts, message.role)

        const isEditable = message.role === 'user' && message.id === editableMessageId

        return (
          <div key={message.id} className="space-y-3">
            {message.role === 'user' ? (
              <div className={isEditable ? 'group relative' : ''}>
                <UserBubble content={sanitizedContent} timestamp={message.timestamp} />
                {isEditable && (
                  <button
                    type="button"
                    className="absolute right-1 top-1 rounded-md p-1 opacity-0 transition-opacity hover:bg-muted/60 group-hover:opacity-100"
                    title="Edit message"
                    onClick={() => onEditMessage(sanitizedContent)}
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
            ) : (
              <AssistantCanvas
                content={sanitizedContent}
                timestamp={message.timestamp}
                parts={sanitizedParts}
              />
            )}

            {messageDrafts.length > 0 && (
              <BoardChatDraftPanel
                drafts={messageDrafts}
                isActive={message.id === draftSourceMessageId}
                onCreate={onCreate}
                onRevise={onRevise}
                onCancel={onCancelDrafts}
              />
            )}
          </div>
        )
      })}

      {userHasScrolledUp && streamingMessage && (
        <button
          type="button"
          onClick={() => {
            userHasScrolledUpRef.current = false
            setUserHasScrolledUp(false)
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: 'smooth'
            })
          }}
          className="sticky bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-md"
        >
          <ArrowDown className="h-3 w-3" /> New messages
        </button>
      )}

      {streamingMessage && (
        <AssistantCanvas
          content={sanitizeBoardMessageContent(streamingMessage)}
          timestamp={streamingMessage.timestamp}
          parts={sanitizeStreamingParts(streamingMessage.parts, streamingMessage.role)}
          isStreaming={true}
        />
      )}

      {activePermission && (
        <PermissionPrompt request={activePermission} onReply={onPermissionReply} />
      )}

      {activeApproval && (
        <CommandApprovalPrompt
          request={activeApproval}
          sessionId={sessionId ?? undefined}
          onReply={onCommandApprovalReply}
        />
      )}

      {activeQuestion && (
        <QuestionPrompt
          request={activeQuestion}
          onReply={onQuestionReply}
          onReject={onQuestionReject}
        />
      )}
    </div>
  )
}

function BoardChatComposer({
  value,
  disabled,
  sending,
  canSend,
  isEditing,
  textareaRef,
  onChange,
  onSend,
  onStop,
  onCancelEdit
}: {
  value: string
  disabled: boolean
  sending: boolean
  canSend: boolean
  isEditing: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onCancelEdit: () => void
}): React.JSX.Element {
  return (
    <div className="border-t border-border/70 px-4 py-3">
      {isEditing && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary">
          <span className="flex items-center gap-1.5 font-medium">
            <Pencil className="h-3.5 w-3.5" />
            Editing message
          </span>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-primary/15"
            onClick={onCancelEdit}
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>
      )}
      <div className="rounded-3xl border border-border/70 bg-muted/20 p-2 shadow-sm">
        <Textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          placeholder={
            disabled
              ? 'Select a target project to start.'
              : 'Can create local tickets. Ask for breakdowns, revisions, or smaller tasks.'
          }
          className="min-h-[84px] resize-none border-0 bg-transparent p-2 shadow-none focus-visible:ring-0"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && isEditing) {
              event.preventDefault()
              onCancelEdit()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        <div className="flex items-center justify-between gap-3 px-2 pb-1">
          <span className="text-xs text-muted-foreground">
            Enter to send. Shift+Enter for a new line.
          </span>
          {sending ? (
            <Button type="button" size="sm" variant="destructive" onClick={onStop}>
              <Square className="h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={onSend} disabled={!canSend}>
              <Send className="h-4 w-4" />
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function BoardAssistantView({
  projectId
}: BoardAssistantViewProps): React.JSX.Element | null {
  const projects = useProjectStore((state) => state.projects)
  const project = projects.find((p) => p.id === projectId)
  const worktree = useWorktreeStore((state) => {
    // find default worktree for project to get path
    for (const worktrees of state.worktreesByProject.values()) {
      const found = worktrees.find((w) => w.project_id === projectId && w.status === 'active')
      if (found) return found
    }
    return null
  })

  const scope = useMemo<BoardChatScope | null>(() => {
    if (!project) return null
    return {
      kind: 'project' as const,
      projectId: project.id,
      projectName: project.name,
      projectPath: worktree?.path ?? project.path
    }
  }, [project, worktree])

  const storedScope = useBoardChatStore((state) => state.scope)
  const messages = useBoardChatStore((state) => state.messages)
  const drafts = useBoardChatStore((state) => state.drafts)
  const createdDraftIds = useBoardChatStore((state) => state.createdDraftIds)
  const draftSourceMessageId = useBoardChatStore((state) => state.draftSourceMessageId)
  const status = useBoardChatStore((state) => state.status)
  const selectedTargetProjectId = useBoardChatStore((state) => state.selectedTargetProjectId)
  const error = useBoardChatStore((state) => state.error)
  const sessionId = useBoardChatStore((state) => state.sessionId)
  const opencodeSessionId = useBoardChatStore((state) => state.opencodeSessionId)
  const runtimePath = useBoardChatStore((state) => state.runtimePath)
  const selectedAgentSdkOverride = useBoardChatStore((state) => state.selectedAgentSdkOverride)
  const selectedModelOverride = useBoardChatStore((state) => state.selectedModelOverride)
  const composerValue = useBoardChatStore((state) => state.composerValue)

  const setTranscriptMessages = useBoardChatStore((state) => state.setTranscriptMessages)
  const addLocalUserMessage = useBoardChatStore((state) => state.addLocalUserMessage)
  const addLocalSystemMessage = useBoardChatStore((state) => state.addLocalSystemMessage)
  const setDrafts = useBoardChatStore((state) => state.setDrafts)
  const clearDrafts = useBoardChatStore((state) => state.clearDrafts)
  const markDraftsCreated = useBoardChatStore((state) => state.markDraftsCreated)
  const setStatus = useBoardChatStore((state) => state.setStatus)
  const setSelectedTargetProjectId = useBoardChatStore((state) => state.setSelectedTargetProjectId)
  const setSelectedAgentSdkOverride = useBoardChatStore(
    (state) => state.setSelectedAgentSdkOverride
  )
  const setSelectedModelOverride = useBoardChatStore((state) => state.setSelectedModelOverride)
  const setError = useBoardChatStore((state) => state.setError)
  const updateOpencodeSessionId = useBoardChatStore((state) => state.updateOpencodeSessionId)
  const setComposerValue = useBoardChatStore((state) => state.setComposerValue)
  const resetState = useBoardChatStore((state) => state.resetState)
  const activateScope = useBoardChatStore((state) => state.activateScope)
  const revertMessageID = useBoardChatStore((state) => state.revertMessageID)
  const setRevertMessageID = useBoardChatStore((state) => state.setRevertMessageID)
  const isEditingMessage = useBoardChatStore((state) => state.isEditingMessage)
  const setIsEditingMessage = useBoardChatStore((state) => state.setIsEditingMessage)
  const setEditingMessageContent = useBoardChatStore((state) => state.setEditingMessageContent)

  const composerFocusRef = useRef<HTMLTextAreaElement | null>(null)
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const defaultBoardAgentSdk = useSettingsStore((state) =>
    resolveBoardChatAgentSdk(state.defaultAgentSdk)
  )
  const baseAgentSdk = selectedAgentSdkOverride ?? defaultBoardAgentSdk
  const resolvedDefaultModel = useSettingsStore((state) =>
    resolveBoardChatDefaultModel(state, baseAgentSdk)
  )
  const effectiveSelectedModel = selectedModelOverride ?? resolvedDefaultModel
  const effectiveAgentSdk = selectedAgentSdkOverride
    ?? coerceBoardAssistantAgentSdk(effectiveSelectedModel?.agentSdk, defaultBoardAgentSdk)
  const agentSdkOptions = useMemo(() => {
    const options: BoardAssistantAgentSdk[] = []
    if (!availableAgentSdks) return [effectiveAgentSdk]
    if (availableAgentSdks.opencode) options.push('opencode')
    if (availableAgentSdks.claude) options.push('claude-code')
    if (availableAgentSdks.codex) options.push('codex')
    return options.length > 0 ? options : [effectiveAgentSdk]
  }, [availableAgentSdks, effectiveAgentSdk])
  const handleMaterializedSessionId = useCallback(
    (nextOpencodeSessionId: string) => {
      updateOpencodeSessionId(nextOpencodeSessionId)
      // After a fork (edit + re-send), the materialized event signals the forked
      // transcript is ready to reload. Clear all editing state so the rewound
      // tail and "Editing" badge go away once the new transcript streams in.
      setRevertMessageID(null)
      setIsEditingMessage(false)
      setEditingMessageContent(null)
      if (sessionId) {
        void dbApi.session
          .update(sessionId, {
            opencode_session_id: nextOpencodeSessionId
          })
          .catch(() => {})
      }
    },
    [sessionId, setEditingMessageContent, setIsEditingMessage, setRevertMessageID, updateOpencodeSessionId]
  )

  useEffect(() => {
    let cancelled = false

    const syncScope = async (): Promise<void> => {
      const scopeKey = buildScopeKey(scope)
      const existingSnapshot =
        scope?.kind === 'project'
          ? useBoardChatStore.getState().getProjectSnapshot(scope.projectId)
          : null

      activateScope(scope, {
        preserveOpen: true,
        scope,
        selectedTargetProjectId:
          scope?.kind === 'project'
            ? scope.projectId
            : scope?.kind === 'connection'
              ? (scope.availableProjects[0]?.id ?? null)
              : null
      })

      if (cancelled) return

      const state = useBoardChatStore.getState()
      if (state.sessionId && state.opencodeSessionId && state.runtimePath && scopeKey !== 'none') {
        try {
          unwrapEnvelope(
            await opencodeApi.reconnect(state.runtimePath, state.opencodeSessionId, state.sessionId)
          )
        } catch {
          // useSessionStream will handle reconnection failures
        }
      }

      if (!existingSnapshot && scope && scope.kind !== 'pinned') {
        addLocalSystemMessage(
          scope.kind === 'project'
            ? `Assistant scope set to ${scope.projectName}.`
            : `Assistant scope set to ${scope.connectionName}.`
        )
      }
    }

    void syncScope()

    return () => {
      cancelled = true
    }
  }, [activateScope, addLocalSystemMessage, scope])

  // NOTE: We intentionally do NOT clean up the runtime on unmount.
  // The board assistant is a persistent tab — the runtime and chat state
  // must survive across tab switches, just like normal sessions.
  // Runtime cleanup happens only when:
  // - The user explicitly closes the board assistant tab (closeBoardAssistantSession)
  // - The scope changes to a different project (scope sync above)
  // - The user clicks "Clear" (handleClear)

  const {
    messages: transcriptMessages,
    streamingParts,
    streamingContent,
    isStreaming
  } = useSessionStream({
    sessionId: sessionId ?? '',
    worktreePath: runtimePath ?? '',
    opencodeSessionId: opencodeSessionId ?? '',
    enabled: Boolean(sessionId && opencodeSessionId && runtimePath),
    onMaterializedSessionId: handleMaterializedSessionId
  })

  useEffect(() => {
    if (!sessionId || !opencodeSessionId || !runtimePath) return
    // useSessionStream starts with an empty array before getMessages() loads.
    // Syncing that empty array would wipe all existing transcript messages from
    // the store (mergeTranscriptMessages only keeps 'local'-kind messages when
    // the transcript array is empty). Skip the sync until real data arrives.
    if (transcriptMessages.length === 0 && useBoardChatStore.getState().messages.length > 0) return
    setTranscriptMessages(transcriptMessages)
  }, [opencodeSessionId, runtimePath, sessionId, setTranscriptMessages, transcriptMessages])

  const latestDraftResult = useMemo(() => {
    const strictProjectId = scope?.kind === 'project' ? scope.projectId : undefined
    const fallbackProjectId = scope?.kind === 'project' ? scope.projectId : selectedTargetProjectId

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'assistant') continue
      const parsed = parseBoardAssistantDraftSet(message.content, {
        fallbackProjectId,
        strictProjectId,
        requireExplicitDraftKeys: scope?.kind === 'project'
      })
      if (parsed) {
        return {
          messageId: message.id,
          drafts: parsed.drafts
        }
      }
    }
    return null
  }, [messages, scope, selectedTargetProjectId])

  // Auto-activate the newest draft set, but only the FIRST time we see a given
  // draft message. Tracking this with a ref (rather than comparing against
  // draftSourceMessageId) means we activate each new draft message exactly once
  // and never fight any later store change on subsequent renders.
  const autoActivatedDraftIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!latestDraftResult || !scope) return
    if (autoActivatedDraftIdRef.current === latestDraftResult.messageId) return

    const targetProjectId =
      scope.kind === 'project'
        ? scope.projectId
        : scope.kind === 'connection'
          ? selectedTargetProjectId
          : null

    if (!targetProjectId) return

    autoActivatedDraftIdRef.current = latestDraftResult.messageId
    setDrafts(
      buildTicketDrafts(
        latestDraftResult.messageId,
        latestDraftResult.drafts,
        scope,
        targetProjectId,
        projects
      ),
      latestDraftResult.messageId
    )
  }, [latestDraftResult, projects, scope, selectedTargetProjectId, setDrafts])

  useEffect(() => {
    if (error) {
      setStatus('error')
      return
    }

    if (isStreaming) {
      setStatus('thinking')
      return
    }

    // Only "awaiting confirmation" while the active set still has uncreated
    // drafts. Once every draft is created the chat returns to idle (re-enabling
    // the edit-message pencil) without needing an explicit Cancel.
    if (drafts.some((draft) => !draft.createdAt)) {
      setStatus('awaiting_confirmation')
      return
    }

    setStatus('idle')
  }, [drafts, error, isStreaming, setStatus])

  const activeQuestion = useQuestionStore((state) =>
    sessionId ? state.getActiveQuestion(sessionId) : null
  )
  const activePermission = usePermissionStore((state) =>
    sessionId ? state.getActivePermission(sessionId) : null
  )
  const activeApproval = useCommandApprovalStore((state) =>
    sessionId ? state.getActiveApproval(sessionId) : null
  )

  const streamingMessage = useMemo<BoardChatMessage | null>(() => {
    if (!isStreaming && streamingParts.length === 0 && !streamingContent) return null
    return {
      id: 'board-chat-streaming',
      role: 'assistant',
      content: streamingContent,
      timestamp: new Date().toISOString(),
      parts: streamingParts,
      kind: 'local'
    }
  }, [isStreaming, streamingContent, streamingParts])

  // Only the last transcript user message is editable. undo() in the backend
  // always rewinds to the most recent user message — there is no arbitrary
  // targeting — so the pencil is hidden while the assistant is busy.
  const editableMessageId = useMemo(() => {
    if (status !== 'idle') return null
    const userMsgs = messages.filter((m) => m.role === 'user' && m.kind === 'transcript')
    return userMsgs.at(-1)?.id ?? null
  }, [messages, status])

  // Immediately hide the rewound tail after undo() so the undone messages do not
  // flash before the forked transcript reloads.
  //
  // NOTE: Unlike SessionView, BoardAssistantView does not clear its messages on a
  // `session.materialized(wasFork: true)` event. This filter plus the transcript
  // reload (which replaces the store messages with the forked transcript) covers
  // the gap; handleMaterializedSessionId clears revertMessageID once that lands.
  const visibleMessages = useMemo(() => {
    if (!revertMessageID) return messages
    const idx = messages.findIndex((m) => m.id === revertMessageID)
    return idx === -1 ? messages : messages.slice(0, idx)
  }, [messages, revertMessageID])

  const canInteract = scope !== null && scope.kind !== 'pinned'
  const canSend =
    canInteract &&
    Boolean(
      (scope?.kind === 'project' ? scope.projectId : selectedTargetProjectId) &&
      composerValue.trim()
    ) &&
    status !== 'starting' &&
    status !== 'thinking'

  const navigateToBoard = useCallback(() => {
    useFileViewerStore.getState().clearActiveViews()

    const sessionStore = useSessionStore.getState()
    sessionStore.setActivePinnedSession(null)

    if (useSettingsStore.getState().boardMode === 'sticky-tab') {
      sessionStore.setActiveSession(BOARD_TAB_ID)
      return
    }

    sessionStore.clearBoardAssistantFocus()
    const kanbanStore = useKanbanStore.getState()
    if (!kanbanStore.isBoardViewActive) {
      kanbanStore.toggleBoardView()
    }
  }, [])

  const handleDiscardConversation = useCallback(
    async (options?: {
      preserveOpen?: boolean
      nextTargetProjectId?: string | null
      nextSelectedAgentSdkOverride?: 'opencode' | 'claude-code' | 'codex' | null
      nextSelectedModelOverride?: SelectedModel | null
    }) => {
      await cleanupBoardChatRuntime()

      const activeScope = useBoardChatStore.getState().scope
      resetState({
        preserveOpen: options?.preserveOpen ?? false,
        scope: activeScope,
        selectedTargetProjectId:
          options?.nextTargetProjectId ??
          (activeScope?.kind === 'project'
            ? activeScope.projectId
            : activeScope?.kind === 'connection'
              ? (activeScope.availableProjects[0]?.id ?? null)
              : null),
        selectedAgentSdkOverride:
          options?.nextSelectedAgentSdkOverride ??
          useBoardChatStore.getState().selectedAgentSdkOverride,
        selectedModelOverride:
          options?.nextSelectedModelOverride ?? useBoardChatStore.getState().selectedModelOverride
      })
    },
    [resetState]
  )

  const handleSend = useCallback(async () => {
    if (!scope || scope.kind === 'pinned') return

    const input = composerValue.trim()
    if (!input) return

    const targetProjectId = scope.kind === 'project' ? scope.projectId : selectedTargetProjectId

    if (!targetProjectId) {
      setError('Select a target project before starting the assistant.')
      addLocalSystemMessage('Select a target project before starting the assistant.')
      return
    }

    // Edit flow (lazy undo): the actual undo() only fires here, on Send. It
    // rewinds the conversation to the most recent user message; the re-sent
    // prompt below then forks a new branch. On failure we stay in editing state
    // so the user keeps their edited text and can retry or cancel.
    if (isEditingMessage) {
      if (!runtimePath || !opencodeSessionId) {
        toast.error('Board assistant is not connected.')
        return
      }
      try {
        const undoResult = unwrapEnvelope(await opencodeApi.undo(runtimePath, opencodeSessionId))
        if (!undoResult.success) {
          toast.error(undoResult.error || 'Nothing to undo')
          return
        }
        setRevertMessageID(undoResult.revertMessageID ?? null)
        setIsEditingMessage(false)
        setEditingMessageContent(null)
      } catch {
        toast.error('Failed to edit message.')
        return
      }
    }

    try {
      setError(null)
      setStatus(sessionId ? 'thinking' : 'starting')
      // Clear the revert marker before the optimistic local message is appended;
      // otherwise visibleMessages would slice off the new message along with the
      // rewound tail. The forked transcript reload replaces the tail afterwards.
      setRevertMessageID(null)
      addLocalUserMessage(input)
      setComposerValue('')

      const runtime = await ensureRuntimeSession(scope, targetProjectId)
      if (!runtime) {
        throw new Error('Unable to start a board assistant session for this board scope.')
      }

      const prompt = buildBoardPrompt(input, scope, targetProjectId)
      const result = unwrapEnvelope(
        await opencodeApi.prompt(runtime.runtimePath, runtime.opencodeSessionId, prompt)
      )
      if (!result.success) {
        throw new Error(result.error || 'The assistant could not send your message.')
      }
    } catch (sendError) {
      const message =
        sendError instanceof Error ? sendError.message : 'Failed to send assistant message.'
      setError(message)
      setStatus('error')
      addLocalSystemMessage(message)
      toast.error(message)
    }
  }, [
    addLocalSystemMessage,
    addLocalUserMessage,
    composerValue,
    isEditingMessage,
    opencodeSessionId,
    runtimePath,
    scope,
    selectedTargetProjectId,
    sessionId,
    setComposerValue,
    setEditingMessageContent,
    setError,
    setIsEditingMessage,
    setRevertMessageID,
    setStatus
  ])

  const handleStartEdit = useCallback(
    (content: string) => {
      setEditingMessageContent(content)
      setIsEditingMessage(true)
      setComposerValue(content)
      composerFocusRef.current?.focus()
    },
    [setComposerValue, setEditingMessageContent, setIsEditingMessage]
  )

  const handleCancelEdit = useCallback(() => {
    setIsEditingMessage(false)
    setEditingMessageContent(null)
    setComposerValue('')
  }, [setComposerValue, setEditingMessageContent, setIsEditingMessage])

  const handleStop = useCallback(async () => {
    const state = useBoardChatStore.getState()
    const activeSessionId = state.sessionId
    const activeOpencodeSessionId = state.opencodeSessionId
    const activeRuntimePath = state.runtimePath

    if (activeSessionId) {
      useQuestionStore.getState().clearSession(activeSessionId)
      usePermissionStore.getState().clearSession(activeSessionId)
      useCommandApprovalStore.getState().clearSession(activeSessionId)
    }

    if (activeRuntimePath && activeOpencodeSessionId) {
      try {
        unwrapEnvelope(await opencodeApi.abort(activeRuntimePath, activeOpencodeSessionId))
      } catch {
        // Best effort — the stream generation guard drops stale events regardless.
      }
    }

    setStatus('idle')
    setError(null)
  }, [setError, setStatus])

  // Shared ticket-creation core used by both the active panel (store drafts) and
  // historical panels (drafts rebuilt inline from a parsed set). Returns true on
  // full success so callers can reflect a "Created" state.
  const createTicketsFromDrafts = useCallback(
    async (draftsToCreate: TicketDraft[]): Promise<boolean> => {
      if (draftsToCreate.length === 0) {
        return false
      }

      try {
        const invalidDrafts = draftsToCreate.filter((draft) => draft.validationIssues.length > 0)
        if (invalidDrafts.length > 0) {
          throw new Error('Fix draft validation issues before creating tickets.')
        }

        const draftsByProject = new Map<string, typeof draftsToCreate>()
        for (const draft of draftsToCreate) {
          draftsByProject.set(draft.projectId, [
            ...(draftsByProject.get(draft.projectId) ?? []),
            draft
          ])
        }
        const batches = [...draftsByProject.entries()].map(([projectId, projectDrafts]) => {
          const projectDraftKeys = new Set(projectDrafts.map((draft) => draft.draftKey))
          return {
            projectId,
            projectName: projectDrafts[0]?.projectName ?? projectId,
            projectDrafts,
            request: kanbanApi.ticket.createBatch<
              KanbanTicketBatchCreateResult,
              KanbanTicketBatchCreate
            >(projectId, {
              drafts: projectDrafts.map((draft) => ({
                draft_key: draft.draftKey,
                project_id: draft.projectId,
                title: draft.title,
                description: draft.description,
                column: 'todo',
                depends_on: draft.dependsOn.filter((key) => projectDraftKeys.has(key))
              }))
            })
          }
        })
        const settled = await Promise.allSettled(batches.map((batch) => batch.request))
        let ticketCount = 0
        let dependencyCount = 0
        const createdDraftIds: string[] = []
        const successfulProjectIds: string[] = []
        const failures: string[] = []

        settled.forEach((result, index) => {
          const batch = batches[index]
          if (result.status === 'fulfilled') {
            ticketCount += result.value.tickets.length
            dependencyCount += result.value.dependencies.length
            createdDraftIds.push(...batch.projectDrafts.map((draft) => draft.id))
            successfulProjectIds.push(batch.projectId)
            return
          }
          const message =
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          failures.push(`${batch.projectName}: ${message}`)
        })

        for (const projectId of successfulProjectIds) {
          await useKanbanStore.getState().loadTickets(projectId)
          await useKanbanStore.getState().loadDependencies(projectId)
        }

        if (createdDraftIds.length > 0) {
          markDraftsCreated(createdDraftIds)
        }

        if (failures.length > 0) {
          throw new Error(
            createdDraftIds.length > 0
              ? `Created ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}, but some projects failed: ${failures.join('; ')}`
              : `Failed to create one or more tickets: ${failures.join('; ')}`
          )
        }

        addLocalSystemMessage(
          `Created ${ticketCount} ticket${ticketCount === 1 ? '' : 's'} and ${dependencyCount} dependenc${dependencyCount === 1 ? 'y' : 'ies'}.`
        )
        navigateToBoard()
        toast.success(`Created ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}.`)
        return true
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to create one or more tickets.'
        toast.error(message)
        return false
      }
    },
    [addLocalSystemMessage, markDraftsCreated, navigateToBoard]
  )

  // Build the rich TicketDraft[] for any message's parsed draft set, resolving
  // the target project and stamping each draft's createdAt from the store's
  // createdDraftIds. Every panel renders + creates from these directly, so
  // per-draft created-state survives the view unmounting (e.g. navigateToBoard)
  // and remounting, and a retry after a partial failure only re-creates the
  // not-yet-created drafts. Returns [] when there is no resolvable project.
  const buildDraftsForMessage = useCallback(
    (parsed: ParsedBoardAssistantDraftSet, messageId: string): TicketDraft[] => {
      if (!scope) return []

      const targetProjectId =
        scope.kind === 'project'
          ? scope.projectId
          : scope.kind === 'connection'
            ? selectedTargetProjectId
            : null
      if (!targetProjectId) return []

      const createdSet = new Set(createdDraftIds)
      return buildTicketDrafts(messageId, parsed.drafts, scope, targetProjectId, projects).map(
        (draft) =>
          createdSet.has(draft.id) ? { ...draft, createdAt: CREATED_DRAFT_MARKER } : draft
      )
    },
    [createdDraftIds, projects, scope, selectedTargetProjectId]
  )

  const handleClear = useCallback(async () => {
    await handleDiscardConversation({ preserveOpen: true })
    if (storedScope && storedScope.kind !== 'pinned') {
      addLocalSystemMessage('Conversation cleared.')
    }
  }, [addLocalSystemMessage, handleDiscardConversation, storedScope])

  const handleSelectModel = useCallback(
    async (model: SelectedModel) => {
      setSelectedModelOverride(model)
      await handleDiscardConversation({
        preserveOpen: true,
        nextSelectedModelOverride: model
      })
      addLocalSystemMessage(
        `Board assistant model changed to ${model.providerID}/${model.modelID}.`
      )
    },
    [addLocalSystemMessage, handleDiscardConversation, setSelectedModelOverride]
  )

  const handleResetModel = useCallback(async () => {
    setSelectedModelOverride(null)
    await handleDiscardConversation({
      preserveOpen: true,
      nextSelectedModelOverride: null
    })
    addLocalSystemMessage('Board assistant model reset to the app default.')
  }, [addLocalSystemMessage, handleDiscardConversation, setSelectedModelOverride])

  const handleSelectAgentSdk = useCallback(
    async (nextAgentSdk: 'opencode' | 'claude-code' | 'codex') => {
      const nextOverride = nextAgentSdk === defaultBoardAgentSdk ? null : nextAgentSdk
      setSelectedAgentSdkOverride(nextOverride)
      setSelectedModelOverride(null)
      await handleDiscardConversation({
        preserveOpen: true,
        nextSelectedAgentSdkOverride: nextOverride,
        nextSelectedModelOverride: null
      })
      addLocalSystemMessage(
        `Board assistant provider changed to ${getAgentSdkLabel(nextAgentSdk)}.`
      )
    },
    [
      addLocalSystemMessage,
      defaultBoardAgentSdk,
      handleDiscardConversation,
      setSelectedAgentSdkOverride,
      setSelectedModelOverride
    ]
  )

  const handleRevise = useCallback(
    (draftsToRevise: TicketDraft[]) => {
      const titles = draftsToRevise
        .map((draft) => `“${draft.title}”`)
        .join(', ')
      setComposerValue(
        titles
          ? `Revise these draft tickets: ${titles}. Keep them small, specific, and implementation-ready.`
          : 'Revise the current draft tickets. Keep them small, specific, and implementation-ready.'
      )
      composerFocusRef.current?.focus()
    },
    [setComposerValue]
  )

  // Dismiss the pending (active) proposal: clear the active store slot so the
  // chat returns to idle. The panel itself stays in the transcript, demoted to a
  // historical set, so its tickets can still be created later.
  const handleCancelDrafts = useCallback(() => {
    clearDrafts()
    addLocalSystemMessage('Dismissed the pending proposal. You can still create it from above.')
  }, [addLocalSystemMessage, clearDrafts])

  const handleSelectTargetProject = useCallback(
    async (nextProjectId: string) => {
      await setSelectedTargetProjectId(nextProjectId)
      await handleDiscardConversation({ preserveOpen: true, nextTargetProjectId: nextProjectId })
      const projectName =
        projects.find((project) => project.id === nextProjectId)?.name ?? 'the selected project'
      addLocalSystemMessage(`Target project changed to ${projectName}.`)
    },
    [addLocalSystemMessage, handleDiscardConversation, projects, setSelectedTargetProjectId]
  )

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: QuestionAnswer[]) => {
      try {
        unwrapEnvelope(
          await opencodeApi.questionReply(requestId, answers, runtimePath || undefined)
        )
        if (sessionId) {
          useQuestionStore.getState().removeQuestion(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to answer assistant question.')
      }
    },
    [runtimePath, sessionId]
  )

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      try {
        unwrapEnvelope(await opencodeApi.questionReject(requestId, runtimePath || undefined))
        if (sessionId) {
          useQuestionStore.getState().removeQuestion(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to dismiss assistant question.')
      }
    },
    [runtimePath, sessionId]
  )

  const handlePermissionReply = useCallback(
    async (requestId: string, reply: 'once' | 'always' | 'reject', message?: string) => {
      try {
        unwrapEnvelope(
          await opencodeApi.permissionReply(requestId, reply, runtimePath || undefined, message)
        )
        if (sessionId) {
          usePermissionStore.getState().removePermission(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to respond to permission request.')
      }
    },
    [runtimePath, sessionId]
  )

  const handleCommandApprovalReply = useCallback(
    async (
      requestId: string,
      approved: boolean,
      remember?: 'allow' | 'block',
      pattern?: string,
      patterns?: string[]
    ) => {
      try {
        unwrapEnvelope(
          await opencodeApi.commandApprovalReply(
            requestId,
            approved,
            remember,
            pattern,
            runtimePath || undefined,
            patterns
          )
        )
        if (sessionId) {
          useCommandApprovalStore.getState().removeApproval(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to respond to command approval request.')
      }
    },
    [runtimePath, sessionId]
  )

  if (!scope) return null

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card">
      <BoardChatHeader
        scope={scope}
        selectedTargetProjectId={selectedTargetProjectId}
        status={status}
        selectedModel={effectiveSelectedModel}
        agentSdk={effectiveAgentSdk}
        availableAgentSdks={agentSdkOptions}
        modelResetVisible={Boolean(selectedModelOverride)}
        onSelectAgentSdk={(agentSdk) => {
          void handleSelectAgentSdk(agentSdk)
        }}
        onSelectModel={(model) => {
          void handleSelectModel(model)
        }}
        onResetModel={() => {
          void handleResetModel()
        }}
        onSelectTargetProject={handleSelectTargetProject}
        onClear={() => {
          void handleClear()
        }}
      />

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <BoardChatMessageList
        messages={visibleMessages}
        drafts={drafts}
        draftSourceMessageId={draftSourceMessageId}
        streamingMessage={streamingMessage}
        activeQuestion={activeQuestion}
        activePermission={activePermission}
        activeApproval={activeApproval}
        sessionId={sessionId}
        editableMessageId={editableMessageId}
        onEditMessage={handleStartEdit}
        buildDraftsForMessage={buildDraftsForMessage}
        onCreate={createTicketsFromDrafts}
        onRevise={handleRevise}
        onCancelDrafts={handleCancelDrafts}
        onQuestionReply={(requestId, answers) => {
          void handleQuestionReply(requestId, answers)
        }}
        onQuestionReject={(requestId) => {
          void handleQuestionReject(requestId)
        }}
        onPermissionReply={(requestId, reply, message) => {
          void handlePermissionReply(requestId, reply, message)
        }}
        onCommandApprovalReply={(requestId, approved, remember, pattern, patterns) => {
          void handleCommandApprovalReply(requestId, approved, remember, pattern, patterns)
        }}
      />

      <BoardChatComposer
        value={composerValue}
        disabled={!canInteract || (scope.kind === 'connection' && !selectedTargetProjectId)}
        sending={status === 'starting' || status === 'thinking'}
        canSend={canSend}
        isEditing={isEditingMessage}
        textareaRef={composerFocusRef}
        onChange={setComposerValue}
        onSend={() => {
          void handleSend()
        }}
        onStop={() => {
          void handleStop()
        }}
        onCancelEdit={handleCancelEdit}
      />
    </div>
  )
}
