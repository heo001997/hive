import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Eye,
  EyeOff,
  X,
  Trash2,
  ExternalLink,
  Hammer,
  AlertTriangle,
  ChevronDown,
  Send,
  Zap,
  AlertCircle,
  Bolt,
  FileSearch,
  GitPullRequest,
  GitMerge,
  GitBranch,
  Archive,
  Loader2,
  Github,
  Upload,
  Lock,
  Plus,
  Map as MapIcon,
  Wand2,
  PanelLeftOpen,
  PanelLeftClose,
  RefreshCw
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownRenderer } from '../sessions/MarkdownRenderer'
import { HandoffSplitButton } from '../sessions/HandoffSplitButton'
import { IndeterminateProgressBar } from '@/components/sessions/IndeterminateProgressBar'
import { cn } from '@/lib/utils'
import { parseTicketKey, ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { BOARD_TAB_ID, useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useClaudeCliSessionPortal } from '@/contexts/ClaudeCliSessionPortalContext'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { isBlockerSatisfied } from '@/lib/blocker-utils'
import { useGitStore } from '@/stores/useGitStore'
import { notifyKanbanSessionSync } from '@/stores/store-coordination'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix, isPlanLike } from '@/lib/constants'
import { buildSdkPlanImplementationPrompt } from '@/lib/proposedPlan'
import { toast } from '@/lib/toast'
import {
  useTicketRunScript,
  useTicketRunScriptHotkey,
  type TicketRunScriptState
} from '@/hooks/useTicketRunScript'
import { TicketRunButton } from './TicketRunButton'
import { ClaudeCliQueueSection } from './ClaudeCliQueueSection'
import { useClaudeCliQueueFeatureActive } from './use-claude-cli-queue-feature'
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'
import { QuestionPrompt } from '@/components/sessions/QuestionPrompt'
import { FollowupInput } from './FollowupInput'
import type { Attachment, AttachmentInput } from '@/components/sessions/AttachmentPreview'
import { buildMessageParts, isImageMime, MAX_ATTACHMENTS } from '@/lib/file-attachment-utils'
import { useDropZone } from '@/hooks/useDropZone'
import { SessionStreamPanel } from './SessionStreamPanel'
import { TicketSessionTabs } from './TicketSessionTabs'
import { TicketSessionPane } from './TicketSessionPane'
import { ReviewTicketDiffSummary, type ReviewTicketDiffFile } from './ReviewTicketDiffSummary'
import { ProviderIcon, getProviderLabel } from '@/components/ui/provider-icon'
import { useLifecycleActions } from '@/hooks/useLifecycleActions'
import { usePinAndActivateSession } from '@/hooks/usePinAndActivateSession'
import { useConflictFixFlow } from '@/hooks/useConflictFixFlow'
import { TicketAttachmentEditor } from './TicketAttachmentEditor'
import { TicketDiscardChangesDialog } from './TicketDiscardChangesDialog'
import { AutoApprovePlanToggle } from './AutoApprovePlanToggle'
import { LifecycleCallbacksEditor } from './LifecycleCallbacksEditor'
import { ConditionGateResultPanel } from './ConditionGateResultPanel'
import { isConditionGate } from '@/lib/ticket-lifecycle'
import { resolveVerifyConfig } from '@/lib/verify-config'
import type { TicketLifecycleConfig } from '@shared/types/ticket-lifecycle'
import type { VerifyOverrides } from '@shared/types/completion'
import { useImagePaste } from '@/hooks/useImagePaste'
import { buildHandoffPrompt, type HandoffSelectionOverride } from '@/lib/handoffSelection'
import { canonicalizeTicketTitle, extractPlanTitle } from '@shared/types/branch-utils'
import { isSessionOwnedByAnotherTicket } from '@/lib/session-ownership'
import { isTerminalBacked } from '@shared/types/agent-sdk'
import type { KanbanTicket, KanbanTicketUpdate, Session, Worktree } from '../../../../main/db/types'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { autoPinBaseWorktree } from '@/lib/auto-pin'
import {
  registerHivePromptHandoff,
  startHivePromptTelemetry
} from '@/lib/hive-enterprise-telemetry'
import { dbApi } from '@/api/db-api'
import { fileApi } from '@/api/file-api'
import { gitApi } from '@/api/git-api'
import { opencodeApi } from '@/api/opencode-api'
import { systemApi } from '@/api/system-api'
import { terminalApi } from '@/api/terminal-api'

// ── Types ───────────────────────────────────────────────────────────
type ModalMode = 'edit' | 'plan_review' | 'review' | 'error' | 'question'
type FollowUpMode = 'build' | 'plan' | 'super-plan'
type ResolvedModalWorktree = Pick<Worktree, 'id' | 'path' | 'branch_name' | 'project_id'> &
  Partial<Pick<Worktree, 'base_branch'>>

function completionSendMode(mode: FollowUpMode): 'build' | 'plan' {
  return isPlanLike(mode) ? 'plan' : 'build'
}

function recordSuccessfulFollowupSideEffects(
  session: { project_id: string; worktree_id: string | null },
  sessionId: string,
  prompt: string,
  followUpMode: FollowUpMode,
  model?: ReturnType<typeof resolveSessionModel>
): void {
  void autoPinBaseWorktree(session.project_id)
  startHivePromptTelemetry({
    sessionId,
    prompt,
    worktreeId: session.worktree_id,
    modelId: model?.modelID,
    providerId: model?.providerID,
    modelVariant: model?.variant,
    mode: followUpMode
  })
}

/** Standard (non-dual-pane) DialogContent className per modal mode */
const MODE_DIALOG_CLASS: Record<ModalMode, string> = {
  edit: 'sm:max-w-lg',
  plan_review: 'sm:max-w-2xl max-h-[80vh] flex flex-col overflow-hidden',
  review: 'sm:max-w-2xl max-h-[80vh] flex flex-col overflow-hidden',
  error: 'sm:max-w-lg',
  question: 'sm:max-w-lg'
}

// TicketAttachment is now imported from TicketAttachmentEditor
type TicketAttachment = import('./TicketAttachmentEditor').TicketAttachment

function ClaudeCliPortalSlot({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { registerTarget } = useClaudeCliSessionPortal()
  const requestSessionMount = useSessionStore((s) => s.requestSessionMount)
  const releaseSessionMount = useSessionStore((s) => s.releaseSessionMount)
  const targetRef = useRef<HTMLDivElement | null>(null)

  const setTargetRef = useCallback(
    (el: HTMLDivElement | null) => {
      targetRef.current = el
      registerTarget(sessionId, el)
    },
    [registerTarget, sessionId]
  )

  useEffect(() => {
    requestSessionMount(sessionId)
    if (targetRef.current) {
      registerTarget(sessionId, targetRef.current)
    }

    return () => {
      registerTarget(sessionId, null)
      releaseSessionMount(sessionId)
    }
  }, [registerTarget, releaseSessionMount, requestSessionMount, sessionId])

  return (
    <div
      ref={setTargetRef}
      className="flex-1 flex flex-col min-h-0"
      data-testid="claude-cli-modal-slot"
    />
  )
}

function normalizeDraftText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function normalizeTicketAttachments(attachments: unknown[]): string {
  return JSON.stringify(
    attachments.map((attachment) => {
      const candidate = attachment as { type?: string; url?: string; label?: string }
      return {
        type: candidate.type ?? '',
        url: candidate.url ?? '',
        label: candidate.label ?? ''
      }
    })
  )
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Find a worktree by its ID across all projects */
function findWorktreeById(worktreeId: string): ResolvedModalWorktree | null {
  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const wt = worktrees.find((w) => w.id === worktreeId)
    if (wt) return wt
  }
  return null
}

/** Find a worktree path by its ID across all projects */
function findWorktreePathById(worktreeId: string): string | null {
  return findWorktreeById(worktreeId)?.path ?? null
}

/** Find a session by ID across worktree and connection session maps, with DB fallback */
async function findSessionById(sessionId: string): Promise<{
  session: {
    id: string
    project_id: string
    worktree_id: string | null
    connection_id: string | null
    opencode_session_id: string | null
    agent_sdk: string
    mode: FollowUpMode
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
  }
  worktreePath: string | null
  connectionId: string | null
  /** Working directory for opencode ops — worktree path or connection path */
  workingPath: string | null
} | null> {
  // Fast path: check in-memory store
  const sessionStore = useSessionStore.getState()
  for (const sessions of sessionStore.sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      let worktreePath = found.worktree_id ? findWorktreePathById(found.worktree_id) : null
      // Worktree not in the in-memory store (project not loaded in sidebar) — try DB
      if (!worktreePath && found.worktree_id) {
        worktreePath = (await dbApi.worktree.get<Worktree>(found.worktree_id))?.path ?? null
      }
      return { session: found, worktreePath, connectionId: null, workingPath: worktreePath }
    }
  }
  for (const [connId, sessions] of sessionStore.sessionsByConnection.entries()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      const connectionPath =
        useConnectionStore.getState().connections.find((c) => c.id === connId)?.path ?? null
      return {
        session: found,
        worktreePath: null,
        connectionId: connId,
        workingPath: connectionPath
      }
    }
  }
  // DB fallback: session not in store (worktree not currently selected)
  const dbSession = await dbApi.session.get<Session>(sessionId)
  if (!dbSession) {
    console.warn(
      `[KanbanTicketModal] findSessionById: session not found in store or DB — sessionId=${sessionId}`
    )
    return null
  }
  // Hydrate into the in-memory store so getWorktreeStatus() and
  // zustand selectors can find this session going forward.
  useSessionStore.getState().hydrateSession(dbSession)

  const worktreePath = dbSession.worktree_id
    ? ((await dbApi.worktree.get<Worktree>(dbSession.worktree_id))?.path ?? null)
    : null
  return {
    session: {
      id: dbSession.id,
      project_id: dbSession.project_id,
      worktree_id: dbSession.worktree_id,
      connection_id: dbSession.connection_id,
      opencode_session_id: dbSession.opencode_session_id,
      agent_sdk: dbSession.agent_sdk,
      mode: dbSession.mode,
      model_provider_id: dbSession.model_provider_id,
      model_id: dbSession.model_id,
      model_variant: dbSession.model_variant
    },
    worktreePath,
    connectionId: dbSession.connection_id,
    workingPath: worktreePath
  }
}

/** Resolve the model to use for a session's next prompt (mirrors SessionView.getModelForRequests) */
function resolveSessionModel(
  sessionId: string,
  sessionDataFallback?: {
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
    agent_sdk: string
  }
): { providerID: string; modelID: string; variant?: string } | undefined {
  // Primary: scan store (picks up mode-specific defaults applied by setSessionMode)
  const state = useSessionStore.getState()
  let session: {
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
    agent_sdk: string
  } | null = null
  for (const sessions of state.sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      session = found
      break
    }
  }
  // Fallback: use provided session data when session not in store (DB fallback path)
  if (!session && sessionDataFallback) {
    session = sessionDataFallback
  }
  // Session has an explicit model — use it
  if (session?.model_provider_id && session.model_id) {
    return {
      providerID: session.model_provider_id,
      modelID: session.model_id,
      variant: session.model_variant ?? undefined
    }
  }
  // Fall back to per-provider default for this session's SDK
  const agentSdk = session?.agent_sdk ?? 'opencode'
  return resolveModelForSdk(agentSdk) ?? undefined
}

/** Send a followup prompt to an existing session */
async function sendFollowupToSession(opts: {
  sessionId: string
  prompt: string
  followUpMode: FollowUpMode
  ticketId: string
  attachments?: Attachment[]
}): Promise<void> {
  const result = await findSessionById(opts.sessionId)
  if (!result) {
    console.error(
      `[KanbanTicketModal] sendFollowupToSession: session not found — sessionId=${opts.sessionId}`
    )
    throw new Error(`Session not found: ${opts.sessionId}`)
  }

  const { session, workingPath, connectionId } = result

  if (!workingPath) {
    console.error(
      `[KanbanTicketModal] sendFollowupToSession: workingPath is null — sessionId=${opts.sessionId}, worktree_id=${session.worktree_id}, connection_id=${session.connection_id}`
    )
    throw new Error(`Working path not found for session: ${opts.sessionId}`)
  }

  // Set session mode so the agent SDK knows we're in plan mode (matches Tab toggle in SessionView).
  // This updates modeBySession, persists to DB, and applies mode-specific default model.
  await useSessionStore.getState().setSessionMode(opts.sessionId, opts.followUpMode)

  // Claude Code & Codex handle plan mode via the SDK — don't prepend the text prefix
  const skipPrefix = session.agent_sdk === 'claude-code' || session.agent_sdk === 'codex'
  const modePrefix =
    opts.followUpMode === 'super-plan'
      ? getSuperPlanModePrefix(session.agent_sdk)
      : opts.followUpMode === 'plan' && !skipPrefix
        ? PLAN_MODE_PREFIX
        : ''
  const fullPrompt = modePrefix + opts.prompt

  // Auto-revert super-plan → plan immediately (one-shot mode).
  // The prefix is already captured in fullPrompt above.
  if (opts.followUpMode === 'super-plan') {
    useSessionStore.getState().setSessionMode(opts.sessionId, 'plan')
  }

  messageSendTimes.set(opts.sessionId, Date.now())
  userExplicitSendTimes.set(opts.sessionId, Date.now())
  snapshotTokenBaseline(opts.sessionId)
  lastSendMode.set(opts.sessionId, completionSendMode(opts.followUpMode))
  useWorktreeStatusStore
    .getState()
    .setSessionStatus(opts.sessionId, isPlanLike(opts.followUpMode) ? 'planning' : 'working')
  bumpWorktreeLastMessage({
    worktreeId: session.worktree_id,
    connectionId: session.connection_id ?? connectionId
  })

  // Resolve model AFTER setSessionMode (which may have applied a mode-specific default)
  const model = resolveSessionModel(opts.sessionId, result.session)

  if (session.agent_sdk === 'claude-code-cli') {
    const delivery = unwrapEnvelope(
      await terminalApi.sendClaudeCliPrompt(opts.sessionId, fullPrompt)
    )
    if (!delivery.delivered) {
      const createResult = unwrapEnvelope(
        await terminalApi.createClaudeCli(opts.sessionId, { pendingPrompt: fullPrompt })
      )
      if (!createResult.success) {
        throw new Error(createResult.error ?? 'Failed to start Claude CLI session')
      }
    }
    recordSuccessfulFollowupSideEffects(
      session,
      opts.sessionId,
      fullPrompt,
      opts.followUpMode,
      model
    )
    return
  }

  if (!session.opencode_session_id) {
    console.error(
      `[KanbanTicketModal] sendFollowupToSession: opencode_session_id is null — sessionId=${opts.sessionId}`
    )
    throw new Error(`No opencode session ID for session: ${opts.sessionId}`)
  }

  // Ensure the session is loaded in the agent SDK implementer's in-memory map.
  // SessionView does this on mount via initializeSession(), but the kanban
  // followup path bypasses SessionView entirely.  Without this, the Claude Code
  // implementer throws "session not found" because its Map was never populated.
  const reconnectResult = unwrapEnvelope(
    await opencodeApi.reconnect(workingPath, session.opencode_session_id, opts.sessionId)
  )
  if (!reconnectResult.success) {
    throw new Error(`Failed to reconnect to session: ${opts.sessionId}`)
  }

  const messageParts = opts.attachments?.length
    ? buildMessageParts(opts.attachments, fullPrompt)
    : [{ type: 'text' as const, text: fullPrompt }]

  const promptResult = unwrapEnvelope(
    await opencodeApi.prompt(workingPath, session.opencode_session_id, messageParts, model)
  )

  if (promptResult && !promptResult.success) {
    console.error(
      `[KanbanTicketModal] sendFollowupToSession: prompt returned failure — error=${promptResult.error}`
    )
    throw new Error(promptResult.error || 'Failed to send prompt to session')
  }
  recordSuccessfulFollowupSideEffects(session, opts.sessionId, fullPrompt, opts.followUpMode, model)
}

/** Determine what mode the modal should operate in */
function resolveModalMode(ticket: KanbanTicket, sessionStatus: string | null): ModalMode {
  // Error mode: linked session has error (can appear in any column)
  if (sessionStatus === 'error') {
    return 'error'
  }
  // Plan review mode: plan_ready flag set (ticket is now in review column)
  if (ticket.plan_ready) {
    return 'plan_review'
  }
  // Review mode: review column
  if (ticket.column === 'review') {
    return 'review'
  }
  // Default: edit mode (todo, done, or simple in_progress tickets)
  return 'edit'
}

function TicketGoalSection({
  ticket,
  isEditMode = false
}: {
  ticket: KanbanTicket
  isEditMode?: boolean
}) {
  if (!ticket.goal_mode || !ticket.goal_success_criteria) return null

  return (
    <div className="space-y-1.5" data-testid="ticket-goal-section">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Goal
        {isEditMode && (
          <span className="ml-2 normal-case text-[10px] text-muted-foreground/70">
            set when launched — read only
          </span>
        )}
      </label>
      <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-sm whitespace-pre-wrap">
        {ticket.goal_success_criteria}
      </div>
    </div>
  )
}

// Per-ticket "Auto-approve Review" switch. Shared between the edit view (todo/done,
// staged into the save flow) and the review view (instant-persist, arms the settle
// timer immediately). Only meaningful for build tickets.
function AutoApproveReviewToggle({
  checked,
  onChange,
  testId
}: {
  checked: boolean
  onChange: (next: boolean) => void
  testId: string
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <label className="text-sm font-medium text-foreground">Auto-approve Review</label>
        <p className="text-xs text-muted-foreground">
          When this build ticket settles in Review, auto-commit it and — if another ticket
          depends on it — advance it to Done so the next chain ticket auto-starts. Runs after the
          global wait time (Settings → General).
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
          checked ? 'bg-primary' : 'bg-muted'
        )}
        data-testid={testId}
      >
        <span
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  )
}

// Tri-state override control (Use global / On / Off) for one verification component.
// `value` is the stored override (null/undefined = follow global/ticket type);
// `effective` is the resolved value shown so the user sees what actually runs.
function TriStateOverride({
  label,
  description,
  value,
  effective,
  onChange,
  testId
}: {
  label: string
  description: string
  value: boolean | null | undefined
  effective: boolean
  onChange: (next: boolean | null) => void
  testId: string
}) {
  const current = value ?? null
  const options: Array<{ key: string; val: boolean | null; text: string }> = [
    { key: 'global', val: null, text: 'Use global' },
    { key: 'on', val: true, text: 'On' },
    { key: 'off', val: false, text: 'Off' }
  ]
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <label className="text-sm font-medium">{label}</label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div
          className="inline-flex shrink-0 overflow-hidden rounded-md border border-border"
          data-testid={testId}
        >
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              aria-pressed={current === opt.val}
              onClick={() => onChange(opt.val)}
              className={cn(
                'px-2 py-1 text-xs font-medium transition-colors',
                current === opt.val
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-muted-foreground hover:bg-muted'
              )}
            >
              {opt.text}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Effective: <span className="font-medium">{effective ? 'On' : 'Off'}</span>
        {current === null && ' (from global / ticket type)'}
      </p>
    </div>
  )
}

// Per-ticket override of the three separable verification components (WS3). Folds
// the stored `verify_overrides` over the global settings via `resolveVerifyConfig`
// and shows the effective value for each. Collapses an all-default override to null
// so a ticket left on "Use global" keeps following Settings.
function VerificationOverridesSection({
  ticket,
  value,
  onChange
}: {
  ticket: KanbanTicket
  value: VerifyOverrides | null
  onChange: (next: VerifyOverrides | null) => void
}) {
  const snapshotEnabled = useSettingsStore((s) => s.kanbanStrictVerifySnapshotEnabled)
  const reviewerEnabled = useSettingsStore((s) => s.kanbanStrictVerifyReviewerEnabled)
  const frozenIdleSeconds = useSettingsStore((s) => s.kanbanStrictVerifyFrozenIdleSeconds)
  const masterEnabled = useSettingsStore((s) => s.kanbanStrictVerifyEnabled)

  const ov = value ?? {}
  const resolved = resolveVerifyConfig(
    { lifecycle_callbacks: ticket.lifecycle_callbacks, verify_overrides: value },
    {
      kanbanStrictVerifySnapshotEnabled: snapshotEnabled,
      kanbanStrictVerifyReviewerEnabled: reviewerEnabled,
      kanbanStrictVerifyFrozenIdleSeconds: frozenIdleSeconds
    }
  )

  // Merge a partial change, drop null/undefined keys, collapse empty → null.
  const patch = (p: Partial<VerifyOverrides>) => {
    const merged: VerifyOverrides = { ...ov, ...p }
    const cleaned: VerifyOverrides = {}
    if (merged.frozenCheck !== null && merged.frozenCheck !== undefined)
      cleaned.frozenCheck = merged.frozenCheck
    if (merged.llmReviewer !== null && merged.llmReviewer !== undefined)
      cleaned.llmReviewer = merged.llmReviewer
    if (merged.gateLoop !== null && merged.gateLoop !== undefined) cleaned.gateLoop = merged.gateLoop
    if (merged.frozenIdleSeconds !== null && merged.frozenIdleSeconds !== undefined)
      cleaned.frozenIdleSeconds = merged.frozenIdleSeconds
    onChange(Object.keys(cleaned).length ? cleaned : null)
  }

  return (
    <div
      className="space-y-3 rounded-md border border-border p-3"
      data-testid="ticket-edit-verify-overrides"
    >
      <div>
        <label className="text-sm font-medium text-foreground">Verification</label>
        <p className="text-xs text-muted-foreground">
          Per-ticket override of the three completion components.{' '}
          {resolved.isGate
            ? 'This is a gate/review ticket — the LLM Reviewer defaults Off (its prose would bounce the ticket) and the gate loop runs Stage-2.'
            : 'This is a normal build ticket — the LLM Reviewer defaults On.'}{' '}
          Leave a control on “Use global” to follow Settings.
        </p>
        {!masterEnabled && (
          <p className="text-[11px] text-amber-500">
            Strict Verify master is Off in Settings — these run only when it&apos;s on.
          </p>
        )}
      </div>

      <TriStateOverride
        label="Frozen check"
        description="Deterministic tty-stillness gate. The trustworthy liveness signal."
        value={ov.frozenCheck}
        effective={resolved.frozenEnabled}
        onChange={(v) => patch({ frozenCheck: v })}
        testId="verify-override-frozen"
      />
      <TriStateOverride
        label="LLM Reviewer"
        description="AI reads the transcript tail. Auto-off on gate/review tickets."
        value={ov.llmReviewer}
        effective={resolved.llmReviewer}
        onChange={(v) => patch({ llmReviewer: v })}
        testId="verify-override-reviewer"
      />
      <TriStateOverride
        label="Gate loop (Stage-2)"
        description="Runs the review→fix condition gate after the frozen check."
        value={ov.gateLoop}
        effective={resolved.gateLoop}
        onChange={(v) => patch({ gateLoop: v })}
        testId="verify-override-gate"
      />

      <div className="space-y-1.5 border-t border-border pt-3">
        <label className="text-sm font-medium">Frozen window override</label>
        <div className="flex items-center gap-3">
          <Input
            type="number"
            min={2}
            max={30}
            placeholder="global"
            value={ov.frozenIdleSeconds ?? ''}
            onChange={(e) => {
              const raw = e.target.value.trim()
              if (raw === '') {
                patch({ frozenIdleSeconds: null })
                return
              }
              const val = parseInt(raw, 10)
              if (!isNaN(val)) patch({ frozenIdleSeconds: Math.max(2, Math.min(30, val)) })
            }}
            className="w-24 font-mono text-sm"
            data-testid="verify-override-frozen-seconds"
          />
          <span className="text-xs text-muted-foreground">
            seconds — effective {Math.round(resolved.frozenIdleMs / 1000)}s (blank = global)
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Component ───────────────────────────────────────────────────────
export function KanbanTicketModal() {
  const selectedTicketRef = useKanbanStore((s) => s.selectedTicketRef)
  const setSelectedTicketId = useKanbanStore((s) => s.setSelectedTicketId)
  const tickets = useKanbanStore((s) => s.tickets)

  // Ticket IDs are project-local in markdown mode, so modal selection must be project-scoped.
  const ticket = useMemo<KanbanTicket | null>(() => {
    if (!selectedTicketRef) return null
    return (
      tickets.get(selectedTicketRef.projectId)?.find((t) => t.id === selectedTicketRef.ticketId) ??
      null
    )
  }, [selectedTicketRef, tickets])

  if (!ticket) return null

  return <KanbanTicketModalContent ticket={ticket} onForceClose={() => setSelectedTicketId(null)} />
}

function MergeConflictBanner({ ticket }: { ticket: KanbanTicket }) {
  const conflictTargetWorktreeId = useWorktreeStatusStore(
    useCallback(
      (state) =>
        ticket.worktree_id
          ? (state.mergeConflictWorktreeByTicket[ticketKey(ticket.project_id, ticket.id)] ??
            ticket.worktree_id)
          : null,
      [ticket.id, ticket.project_id, ticket.worktree_id]
    )
  )
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => {
        if (!conflictTargetWorktreeId) return null
        for (const worktrees of state.worktreesByProject.values()) {
          const found = worktrees.find((w) => w.id === conflictTargetWorktreeId)
          if (found) return found.path
        }
        return null
      },
      [conflictTargetWorktreeId]
    )
  )
  const hasConflicts = useGitStore(
    useCallback(
      (state) => (worktreePath ? (state.conflictsByWorktree[worktreePath] ?? false) : false),
      [worktreePath]
    )
  )
  const conflictFlow = useWorktreeStatusStore(
    useCallback(
      (state) =>
        conflictTargetWorktreeId
          ? state.mergeConflictFlowByWorktree[conflictTargetWorktreeId]
          : undefined,
      [conflictTargetWorktreeId]
    )
  )
  const mergeConflictMode = useSettingsStore((s) => s.mergeConflictMode)
  const { startFixFlow, openAttachedSession } = useConflictFixFlow(conflictTargetWorktreeId)

  if (!ticket.worktree_id || ticket.archived_at || !hasConflicts) return null

  const isConflictFlowActive =
    conflictFlow?.phase === 'starting' ||
    conflictFlow?.phase === 'running' ||
    conflictFlow?.phase === 'refreshing'

  return (
    <div
      data-testid="ticket-modal-fix-conflicts-banner"
      className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" />
        Merge conflicts detected
      </div>
      {isConflictFlowActive ? (
        <button
          type="button"
          className="flex items-center"
          onClick={(e) => {
            e.stopPropagation()
            if (conflictFlow?.phase !== 'starting') openAttachedSession()
          }}
        >
          <IndeterminateProgressBar
            mode={ticket.mode || 'build'}
            isFixingConflicts
            className="w-24"
          />
        </button>
      ) : mergeConflictMode === 'always-ask' ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="destructive" className="h-7 text-xs font-semibold">
              <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              Fix conflicts
              <ChevronDown className="h-3 w-3 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                void startFixFlow('build')
              }}
            >
              <Hammer className="h-4 w-4 mr-2" />
              Fix in Build mode
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                void startFixFlow('plan')
              }}
            >
              <MapIcon className="h-4 w-4 mr-2" />
              Fix in Plan mode
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          className="h-7 text-xs font-semibold"
          onClick={(e) => {
            e.stopPropagation()
            void startFixFlow()
          }}
        >
          <AlertTriangle className="h-3.5 w-3.5 mr-1" />
          Fix conflicts
        </Button>
      )}
    </div>
  )
}

// ── Inner content (only rendered when ticket is non-null) ───────────
function KanbanTicketModalContent({
  ticket,
  onForceClose
}: {
  ticket: KanbanTicket
  onForceClose: () => void
}) {
  const updateTicket = useKanbanStore((s) => s.updateTicket)
  const deleteTicket = useKanbanStore((s) => s.deleteTicket)
  const moveTicket = useKanbanStore((s) => s.moveTicket)
  const [editDraftDirty, setEditDraftDirty] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  // ── Mark a Review ticket "seen" the moment its detail opens ─────────
  // Opening the modal IS the "click in" the board glow flags. Covers every
  // open path (card click, navigate-to-ticket, notifications). Fire-and-forget:
  // updateTicket's optimistic write clears the card glow immediately.
  const reviewSeenMarkedRef = useRef<string | null>(null)
  useEffect(() => {
    if (ticket.column !== 'review' || ticket.review_seen_at) return
    if (reviewSeenMarkedRef.current === ticket.id) return
    reviewSeenMarkedRef.current = ticket.id
    void updateTicket(ticket.id, ticket.project_id, {
      review_seen_at: new Date().toISOString()
    }).catch(() => {})
  }, [ticket.id, ticket.column, ticket.review_seen_at, ticket.project_id, updateTicket])

  // ── Run script state (shared across all modal modes) ─────────────
  // Hoisted here so the Cmd+R hotkey registers exactly once, and so each
  // mode receives the same state object via props.
  const runScriptState = useTicketRunScript(ticket)
  useTicketRunScriptHotkey(runScriptState)

  // ── Session lookup ────────────────────────────────────────────────
  const sessionStatus = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  const sessionRecord = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  // A ticket's current_session_id can point at a session ANOTHER ticket also owns
  // when they share a worktree (corrupted data from before the auto-attach fix, or
  // a manual double-bind). Never auto-mount a borrowed session as THIS ticket's
  // terminal — that's exactly how the detail opened the wrong ticket's terminal.
  // Treat it as session-less for the default view; the worktree tab strip below
  // still lets the user open that session deliberately.
  const sessionOwnedByOther = useKanbanStore(
    useCallback(
      (s) =>
        !!ticket.current_session_id &&
        isSessionOwnedByAnotherTicket(s.tickets, ticket.current_session_id, ticket.id),
      [ticket.current_session_id, ticket.id]
    )
  )
  const ownPrimarySessionId = sessionOwnedByOther ? null : ticket.current_session_id

  // ── DB session fallback ──────────────────────────────────────────
  // When zustand selectors return null (session not in sessionsByWorktree
  // or sessionsByConnection), fall back to the DB via findSessionById —
  // the same 3-tier lookup that sendFollowupToSession already uses.
  const [dbSessionInfo, setDbSessionInfo] = useState<{
    session: {
      id: string
      worktree_id: string | null
      connection_id: string | null
      opencode_session_id: string | null
      agent_sdk: string
      mode: FollowUpMode
      model_provider_id: string | null
      model_id: string | null
      model_variant: string | null
    }
    worktreePath: string | null
  } | null>(null)

  // Tracks when findSessionById definitively returns null (session not
  // in store or DB).  Used to fall back to the standard (no-session)
  // layout instead of showing a perpetual spinner.
  const [sessionLoadFailed, setSessionLoadFailed] = useState(false)

  // Guards against a race where loadSessions (which replaces
  // sessionsByWorktree entirely with active-only sessions) would wipe
  // out a session that hydrateSession just added from the DB fallback.
  const isLoadingDbSession = useRef(false)

  useEffect(() => {
    if (!ticket.current_session_id) {
      setDbSessionInfo(null)
      setSessionLoadFailed(false)
      isLoadingDbSession.current = false
      return
    }
    if (sessionRecord) {
      // Session found in zustand — don't clear dbSessionInfo because its
      // worktreePath is still needed as a fallback until dbWorktreePath
      // loads from its own async effect.
      // Only clear if it belongs to a different session (ticket switched).
      if (dbSessionInfo && dbSessionInfo.session.id !== ticket.current_session_id) {
        setDbSessionInfo(null)
      }
      setSessionLoadFailed(false)
      isLoadingDbSession.current = false
      return
    }
    let cancelled = false
    // Set synchronously so the hasAttemptedSessionLoad effect (which
    // fires in the same micro-task batch) sees it before calling loadSessions.
    isLoadingDbSession.current = true
    setSessionLoadFailed(false)
    findSessionById(ticket.current_session_id)
      .then((result) => {
        if (cancelled) return
        if (!result) {
          setSessionLoadFailed(true)
          return
        }
        setDbSessionInfo({ session: result.session, worktreePath: result.workingPath })
      })
      .finally(() => {
        if (!cancelled) isLoadingDbSession.current = false
      })
    return () => {
      cancelled = true
      isLoadingDbSession.current = false
    }
  }, [ticket.current_session_id, sessionRecord])

  // Eagerly load sessions when a ticket has a session but it's not in the
  // in-memory store (e.g. the worktree isn't currently selected).  Guard
  // with a ref so we only attempt once per ticket to avoid infinite loops
  // when the session genuinely doesn't exist in the loaded worktree.
  const hasAttemptedSessionLoad = useRef(false)
  useEffect(() => {
    if (!ticket.current_session_id || sessionRecord || dbSessionInfo) {
      hasAttemptedSessionLoad.current = false
      return
    }
    if (!ticket.worktree_id || !ticket.project_id) return
    if (hasAttemptedSessionLoad.current) return
    // Don't call loadSessions while the DB fallback lookup is in-flight —
    // loadSessions replaces sessionsByWorktree entirely with active-only
    // sessions, which would wipe out the session hydrateSession adds.
    if (isLoadingDbSession.current) return
    hasAttemptedSessionLoad.current = true
    useSessionStore.getState().loadSessions(ticket.worktree_id, ticket.project_id)
  }, [
    ticket.current_session_id,
    ticket.worktree_id,
    ticket.project_id,
    sessionRecord,
    dbSessionInfo
  ])

  const pendingPlan = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.pendingPlans.get(ticket.current_session_id) ?? null
      },
      [ticket.current_session_id]
    )
  )

  const activeQuestion = useQuestionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        const questions = state.pendingBySession.get(ticket.current_session_id)
        return questions?.[0] ?? null
      },
      [ticket.current_session_id]
    )
  )

  const [dbWorktreePath, setDbWorktreePath] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionRecord?.worktree_id) {
      setDbWorktreePath(null)
      return
    }

    const inMemory = findWorktreePathById(sessionRecord.worktree_id)
    if (inMemory) {
      setDbWorktreePath(null)
      return
    }

    // Worktree not in store — load from DB
    dbApi.worktree.get<Worktree>(sessionRecord.worktree_id).then((wt) => {
      setDbWorktreePath(wt?.path ?? null)
    })
  }, [sessionRecord?.worktree_id])

  const effectiveSession = sessionRecord ?? dbSessionInfo?.session ?? null
  const isClaudeCli = effectiveSession?.agent_sdk === 'claude-code-cli'
  const currentWorktreeSessionStatus = useWorktreeStatusStore(
    useCallback(
      (state) =>
        ticket.current_session_id
          ? (state.sessionStatuses[ticket.current_session_id]?.status ?? null)
          : null,
      [ticket.current_session_id]
    )
  )

  const baseModalMode = resolveModalMode(ticket, sessionStatus)
  // Question mode takes highest priority — an unanswered question blocks
  // the agent regardless of other ticket state (error, plan_ready, etc.)
  const modalMode = activeQuestion ? 'question' : baseModalMode

  useEffect(() => {
    setEditDraftDirty(false)
    setShowDiscardConfirm(false)
  }, [ticket.id, modalMode])

  const forceClose = useCallback(() => {
    setShowDiscardConfirm(false)
    onForceClose()
  }, [onForceClose])

  // Auto-close the modal when an answered CLI question resumes work
  // (answering → working). `isClaudeCli` derives from the DB-loaded session and
  // can resolve a render or two after the modal opens, so we must NOT gate the
  // status tracking on it — otherwise a flip that lands before it resolves slides
  // the baseline forward under the early-return branch and the transition is lost
  // forever. Instead we latch `sawAnswering` unconditionally and gate only the
  // close *action* on `isClaudeCli`; the effect re-runs when `isClaudeCli`
  // resolves (it's a dep), so a flip seen while it was still false is honored as
  // soon as it becomes true.
  const autoCloseLatchRef = useRef<{ sessionId: string | null; sawAnswering: boolean }>({
    sessionId: null,
    sawAnswering: false
  })
  useEffect(() => {
    const sessionId = ticket.current_session_id
    const latch = autoCloseLatchRef.current

    if (!sessionId) {
      autoCloseLatchRef.current = { sessionId: null, sawAnswering: false }
      return
    }

    // First observation of this session — seed the latch from the current status
    // so a modal opened on a session already in `answering` still arms.
    if (latch.sessionId !== sessionId) {
      autoCloseLatchRef.current = {
        sessionId,
        sawAnswering: currentWorktreeSessionStatus === 'answering'
      }
      return
    }

    if (currentWorktreeSessionStatus === 'answering') {
      latch.sawAnswering = true
      return
    }

    if (isClaudeCli && latch.sawAnswering && currentWorktreeSessionStatus === 'working') {
      latch.sawAnswering = false
      forceClose()
    }
  }, [currentWorktreeSessionStatus, forceClose, isClaudeCli, ticket.current_session_id])

  const requestClose = useCallback(() => {
    if (modalMode === 'edit' && editDraftDirty) {
      setShowDiscardConfirm(true)
      return
    }
    forceClose()
  }, [editDraftDirty, forceClose, modalMode])

  const handleDialogOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        requestClose()
      }
    },
    [requestClose]
  )

  // ── Session stream resolution ────────────────────────────────────
  let worktreePath: string | null = null
  if (effectiveSession?.worktree_id) {
    worktreePath =
      findWorktreePathById(effectiveSession.worktree_id) ??
      dbWorktreePath ??
      dbSessionInfo?.worktreePath ??
      null
  } else if (effectiveSession?.connection_id) {
    worktreePath =
      useConnectionStore.getState().connections.find((c) => c.id === effectiveSession.connection_id)
        ?.path ??
      dbSessionInfo?.worktreePath ??
      null
  } else if (dbSessionInfo?.worktreePath) {
    worktreePath = dbSessionInfo.worktreePath
  }
  const storeOpcSessionId: string | null = effectiveSession?.opencode_session_id ?? null

  // If the Zustand store still has a placeholder `pending::` ID, the real
  // materialized ID may already be in the DB (the backend updates it during
  // the first prompt).  Re-read from the DB to resolve it.
  const [resolvedOpcSessionId, setResolvedOpcSessionId] = useState<string | null>(null)
  useEffect(() => {
    if (
      !storeOpcSessionId ||
      !storeOpcSessionId.startsWith('pending::') ||
      !ticket.current_session_id
    ) {
      setResolvedOpcSessionId(null)
      return
    }
    let cancelled = false
    dbApi.session
      .get<Pick<Session, 'opencode_session_id'>>(ticket.current_session_id)
      .then((dbSess: { opencode_session_id?: string | null } | null) => {
        if (cancelled) return
        const dbId = dbSess?.opencode_session_id ?? null
        if (dbId && !dbId.startsWith('pending::')) {
          console.info(
            '[KanbanModal] resolved pending:: ID from DB — store=%s, db=%s',
            storeOpcSessionId,
            dbId
          )
          // Also update the Zustand store so other components pick it up
          useSessionStore.getState().setOpenCodeSessionId(ticket.current_session_id!, dbId)
          setResolvedOpcSessionId(dbId)
        }
      })
    return () => {
      cancelled = true
    }
  }, [storeOpcSessionId, ticket.current_session_id])

  const opcSessionId = resolvedOpcSessionId ?? storeOpcSessionId
  const hasSession = !!(
    ticket.current_session_id &&
    worktreePath &&
    opcSessionId &&
    !opcSessionId.startsWith('pending::')
  )
  const conflictBanner = <MergeConflictBanner ticket={ticket} />

  // Show the wide session layout (tab strip + session pane) whenever the ticket
  // has a workspace — even a session-less TODO with a worktree gets the strip so
  // the first terminal/agent can be spawned. Commits as soon as a session is
  // known (before async DB lookups resolve) to avoid a flash of the narrow modal;
  // falls back to the standard layout only when there's neither a worktree nor a
  // (still-loading) linked session.
  const wantsDualPane =
    !!ticket.worktree_id || (!!ticket.current_session_id && !sessionLoadFailed)

  const [sessionReady, setSessionReady] = useState(false)

  console.info(
    '[KanbanModal] session resolution — ticket.current_session_id=%s, worktreePath=%s, opcSessionId=%s (store=%s), hasSession=%s, sessionReady=%s, agent_sdk=%s, sessionLoadFailed=%s',
    ticket.current_session_id,
    worktreePath,
    opcSessionId,
    storeOpcSessionId,
    hasSession,
    sessionReady,
    effectiveSession?.agent_sdk,
    sessionLoadFailed
  )

  useEffect(() => {
    if (isClaudeCli || !worktreePath || !opcSessionId || !ticket.current_session_id) {
      setSessionReady(false)
      return
    }

    let cancelled = false
    setSessionReady(false)

    // Mirror SessionView's init flow: reconnect → getMessages in one async
    // sequence.  The getMessages() call pre-warms the backend's in-memory
    // message cache (for Claude Code sessions this triggers readClaudeTranscript
    // from disk; for OpenCode sessions it pokes the server).  Without this,
    // SessionStreamPanel's useSessionStream hook may call getMessages() before
    // the cache is warm and receive an empty result.
    console.info(
      '[KanbanModal:sessionReady] starting — worktreePath=%s, opcSessionId=%s, hiveSessionId=%s',
      worktreePath,
      opcSessionId,
      ticket.current_session_id
    )
    ;(async () => {
      try {
        const sessionId = ticket.current_session_id
        if (!sessionId) return
        const reconnResult = unwrapEnvelope(
          await opencodeApi.reconnect(worktreePath, opcSessionId, sessionId)
        )
        console.info('[KanbanModal:sessionReady] reconnect result:', reconnResult)
      } catch (err) {
        console.warn('[KanbanModal:sessionReady] reconnect failed:', err)
        // reconnect failure is non-fatal — still try to show messages
      }

      // Pre-warm: load messages into the backend cache so the next
      // getMessages() call from useSessionStream finds them immediately.
      try {
        const warmResult = unwrapEnvelope(await opencodeApi.getMessages(worktreePath, opcSessionId))
        console.info(
          '[KanbanModal:sessionReady] pre-warm getMessages — success=%s, messageCount=%d',
          warmResult.success,
          Array.isArray(warmResult.messages) ? warmResult.messages.length : 0
        )
      } catch (err) {
        console.warn('[KanbanModal:sessionReady] pre-warm getMessages failed:', err)
        // Pre-warm failure is non-fatal
      }

      if (!cancelled) {
        console.info('[KanbanModal:sessionReady] setting sessionReady=true')
        setSessionReady(true)
      } else {
        console.info('[KanbanModal:sessionReady] cancelled, not setting sessionReady')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isClaudeCli, worktreePath, opcSessionId, ticket.current_session_id])

  // ── Active-viewed session (ticket detail tab strip) ─────────────────
  // The strip lets the user view any session in the ticket's worktree. This is
  // VIEW-ONLY: switching tabs never changes the ticket's primary
  // current_session_id (which drives status) nor the board's global
  // activeSessionId. The last-viewed tab is persisted per ticket.
  const persistedTicketView = useSessionStore(
    useCallback((s) => s.activeViewByTicket[ticket.id] ?? null, [ticket.id])
  )
  const setTicketActiveView = useSessionStore((s) => s.setTicketActiveView)
  const [activeViewSessionId, setActiveViewSessionId] = useState<string | null>(
    () => persistedTicketView ?? ownPrimarySessionId ?? null
  )
  // Whether the in-progress full-width session layout reveals the ticket-detail
  // pane next to the terminal. Defaults closed; reset when the modal is reused
  // for a different ticket (handled in the seed effect below).
  const [showDetailPane, setShowDetailPane] = useState(false)
  // Re-seed once when the modal is reused for a different ticket. Guarded by a
  // ref so the persisted/primary deps can't clobber a tab the user just picked.
  const seededTicketRef = useRef<string | null>(null)
  useEffect(() => {
    if (seededTicketRef.current === ticket.id) return
    seededTicketRef.current = ticket.id
    setActiveViewSessionId(persistedTicketView ?? ownPrimarySessionId ?? null)
    setShowDetailPane(false)
  }, [ticket.id, persistedTicketView, ownPrimarySessionId])

  const selectTicketView = useCallback(
    (sessionId: string | null) => {
      setActiveViewSessionId(sessionId)
      setTicketActiveView(ticket.id, sessionId)
    },
    [setTicketActiveView, ticket.id]
  )

  // Follow external view changes that bypass the tab strip — e.g. "Create PR"
  // opens a fresh Claude Code CLI terminal and points this ticket's view at it
  // via setTicketActiveView (store-only). Mirror that into local state so the
  // session pane switches to the new terminal and the user can watch the PR
  // being created. selectTicketView already keeps store and local in sync for
  // user-driven tab picks, so the equality guard makes this a no-op for those.
  useEffect(() => {
    if (persistedTicketView && persistedTicketView !== activeViewSessionId) {
      setActiveViewSessionId(persistedTicketView)
    }
  }, [persistedTicketView, activeViewSessionId])

  // Clamp the viewed tab back to the primary if the session it points at has
  // disappeared (e.g. closed from the board while this modal is open). Gated on
  // the worktree's session list actually being loaded so we never reset a valid
  // view during the brief window before sessions hydrate.
  const activeViewMissing = useSessionStore(
    useCallback(
      (s) => {
        const id = activeViewSessionId
        if (!id || id === ticket.current_session_id) return false
        const wtId = ticket.worktree_id
        if (!wtId || !s.sessionsByWorktree.has(wtId)) return false // not loaded yet
        return !(s.sessionsByWorktree.get(wtId) ?? []).some((x) => x.id === id)
      },
      [activeViewSessionId, ticket.current_session_id, ticket.worktree_id]
    )
  )
  useEffect(() => {
    if (activeViewMissing) selectTicketView(ticket.current_session_id ?? null)
  }, [activeViewMissing, selectTicketView, ticket.current_session_id])

  const isPrimaryTerminalBacked = isTerminalBacked(effectiveSession?.agent_sdk)
  const viewingPrimary = !activeViewSessionId || activeViewSessionId === ownPrimarySessionId
  // Render the primary session's battle-tested native path only when the user is
  // actually viewing the primary; other tabs (and the session-less empty state)
  // go through TicketSessionPane. Uses ownPrimarySessionId (not the raw
  // current_session_id) so a session another ticket owns is never auto-mounted here.
  const showPrimaryNative = viewingPrimary && !!ownPrimarySessionId

  // Render the mode-specific inner content (without DialogContent wrapper)
  let modeContent: React.ReactNode
  switch (modalMode) {
    case 'edit':
      modeContent = (
        <EditModeContent
          ticket={ticket}
          onClose={forceClose}
          onRequestClose={requestClose}
          onDirtyChange={setEditDraftDirty}
          updateTicket={updateTicket}
          deleteTicket={deleteTicket}
          runScriptState={runScriptState}
        />
      )
      break
    case 'plan_review':
      modeContent = (
        <PlanReviewModeContent
          ticket={ticket}
          onClose={forceClose}
          pendingPlan={pendingPlan}
          sessionRecord={effectiveSession}
          updateTicket={updateTicket}
          dualPane={wantsDualPane}
          worktreePath={worktreePath}
          opcSessionId={opcSessionId}
          runScriptState={runScriptState}
        />
      )
      break
    case 'review':
      modeContent = (
        <ReviewModeContent
          ticket={ticket}
          onClose={forceClose}
          moveTicket={moveTicket}
          updateTicket={updateTicket}
          dualPane={wantsDualPane}
          runScriptState={runScriptState}
        />
      )
      break
    case 'error':
      modeContent = (
        <ErrorModeContent
          ticket={ticket}
          onClose={forceClose}
          dualPane={wantsDualPane}
          runScriptState={runScriptState}
        />
      )
      break
    case 'question':
      modeContent = (
        <QuestionModeContent
          ticket={ticket}
          onClose={forceClose}
          activeQuestion={activeQuestion!}
          dualPane={wantsDualPane}
          runScriptState={runScriptState}
        />
      )
      break
  }

  // ── Full-width session layout (in-progress edit mode) ──
  // The terminal/session pane fills the dialog by default; the ticket-detail pane
  // is opt-in via the "Detail" toggle in the tab strip (showDetailPane) so the
  // title/description/dependencies/actions stay reachable without leaving the run.
  let dialogBody: React.ReactNode

  if (wantsDualPane && modalMode === 'edit' && ticket.column === 'in_progress') {
    dialogBody = (
      <DialogContent
        data-testid="kanban-ticket-modal"
        className="w-[96vw] max-w-[1920px] h-[90vh] p-0 gap-0 overflow-hidden flex flex-col"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{ticket.title}</DialogTitle>
        </DialogHeader>
        {conflictBanner}
        <TicketSessionTabs
          ticket={ticket}
          activeViewSessionId={activeViewSessionId}
          onSelectView={selectTicketView}
          onSpawned={selectTicketView}
          trailing={
            <button
              type="button"
              onClick={() => setShowDetailPane((v) => !v)}
              aria-pressed={showDetailPane}
              data-testid="toggle-ticket-detail"
              title={showDetailPane ? 'Hide ticket detail' : 'Show ticket detail'}
              className={cn(
                'flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm border-l border-border transition-colors',
                showDetailPane
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {showDetailPane ? (
                <PanelLeftClose className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              )}
              Detail
            </button>
          }
        />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {showDetailPane && (
            <div
              data-testid="ticket-detail-pane"
              className="w-[480px] shrink-0 h-full flex flex-col overflow-y-auto p-6 gap-4 border-r border-border/60"
            >
              {modeContent}
            </div>
          )}
          {showPrimaryNative ? (
            isPrimaryTerminalBacked && ticket.current_session_id ? (
              <div className="flex flex-col h-full bg-background flex-1 min-w-0">
                <div className="shrink-0 px-4 py-3 border-b border-border/60 flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground truncate min-w-0">
                    {ticket.title}
                  </span>
                  <div className="ml-auto shrink-0 flex items-center gap-2">
                    <ClaudeCliQueueSection ticket={ticket} />
                    <TicketRunButton
                      state={runScriptState}
                      testId="full-width-run-btn"
                      className="h-7 px-2 text-xs"
                    />
                    <JumpToSessionButton
                      ticket={ticket}
                      onClose={forceClose}
                      label="Go to session"
                      testId="go-to-session-btn"
                    />
                  </div>
                </div>
                <ClaudeCliPortalSlot sessionId={ticket.current_session_id} />
              </div>
            ) : hasSession && sessionReady ? (
              <SessionStreamPanel
                sessionId={ticket.current_session_id!}
                worktreePath={worktreePath!}
                opencodeSessionId={opcSessionId!}
                title={ticket.title}
                headerAction={
                  <div className="flex items-center gap-2">
                    <TicketRunButton
                      state={runScriptState}
                      testId="full-width-run-btn"
                      className="h-7 px-2 text-xs"
                    />
                    <JumpToSessionButton
                      ticket={ticket}
                      onClose={forceClose}
                      label="Go to session"
                      testId="go-to-session-btn"
                    />
                  </div>
                }
                fullWidth
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent" />
              </div>
            )
          ) : (
            <TicketSessionPane
              sessionId={activeViewSessionId}
              fullWidth
              headerAction={
                <TicketRunButton
                  state={runScriptState}
                  testId="full-width-run-btn"
                  className="h-7 px-2 text-xs"
                />
              }
            />
          )}
        </div>
      </DialogContent>
    )
  } else if (wantsDualPane) {
    // ── Dual-pane layout (ticket + session stream) ──────────────────
    dialogBody = (
      <DialogContent
        data-testid="kanban-ticket-modal"
        className="w-[96vw] max-w-[1920px] h-[90vh] p-0 gap-0 overflow-hidden flex flex-col"
      >
        {conflictBanner}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left: ticket content */}
          <div className="w-[480px] shrink-0 h-full flex flex-col overflow-y-auto p-6 gap-4">
            {/* Shared ticket context header for non-edit modes */}
            {modalMode !== 'edit' && (
              <div className="space-y-2 pb-3 border-b border-border/40">
                <h2 className="text-base font-semibold text-foreground leading-tight break-words">
                  {ticket.title}
                </h2>
                {ticket.description && (
                  <div className="prose prose-sm dark:prose-invert max-w-none text-sm text-muted-foreground max-h-[120px] overflow-y-auto">
                    <MarkdownRenderer content={ticket.description} />
                  </div>
                )}
                <TicketGoalSection ticket={ticket} />
              </div>
            )}
            {modeContent}
          </div>
          {/* Right: tab strip + session pane (or loading spinner while DB lookup resolves) */}
          <div className="flex-1 min-w-0 h-full flex flex-col border-l border-border/60">
            <TicketSessionTabs
              ticket={ticket}
              activeViewSessionId={activeViewSessionId}
              onSelectView={selectTicketView}
              onSpawned={selectTicketView}
            />
            <div className="flex-1 min-h-0 flex flex-col">
              {showPrimaryNative ? (
                isPrimaryTerminalBacked && ticket.current_session_id ? (
                  <div className="flex flex-col h-full bg-background flex-1 min-w-0">
                    <ClaudeCliPortalSlot sessionId={ticket.current_session_id} />
                  </div>
                ) : hasSession && sessionReady ? (
                  <SessionStreamPanel
                    sessionId={ticket.current_session_id!}
                    worktreePath={worktreePath!}
                    opencodeSessionId={opcSessionId!}
                    fullWidth
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent" />
                  </div>
                )
              ) : (
                <TicketSessionPane
                  sessionId={activeViewSessionId}
                  fullWidth
                  headerAction={
                    <TicketRunButton
                      state={runScriptState}
                      testId="dual-pane-run-btn"
                      className="h-7 px-2 text-xs"
                    />
                  }
                />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    )
  } else {
    // ── Standard layout (no session) ────────────────────────────────
    dialogBody = (
      <DialogContent data-testid="kanban-ticket-modal" className={MODE_DIALOG_CLASS[modalMode]}>
        {conflictBanner}
        {modeContent}
      </DialogContent>
    )
  }

  return (
    <Dialog open onOpenChange={handleDialogOpenChange}>
      {dialogBody}
      <TicketDiscardChangesDialog
        open={showDiscardConfirm}
        onKeepEditing={() => setShowDiscardConfirm(false)}
        onDiscard={forceClose}
      />
    </Dialog>
  )
}

// ════════════════════════════════════════════════════════════════════
// EDIT MODE
// ════════════════════════════════════════════════════════════════════

function EditModeContent({
  ticket,
  onClose,
  onRequestClose,
  onDirtyChange,
  updateTicket,
  deleteTicket,
  runScriptState
}: {
  ticket: KanbanTicket
  onClose: () => void
  onRequestClose: () => void
  onDirtyChange: (isDirty: boolean) => void
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  deleteTicket: (ticketId: string, projectId: string) => Promise<void>
  runScriptState: TicketRunScriptState
}) {
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description ?? '')
  const [showPreview, setShowPreview] = useState(false)
  const [attachments, setAttachments] = useState<TicketAttachment[]>(
    () =>
      (ticket.attachments as Array<{ type: string; url: string; label: string }>).map((a) => ({
        type: a.type as 'jira' | 'figma' | 'file' | 'image',
        url: a.url,
        label: a.label
      })) ?? []
  )
  const [autoApproveReview, setAutoApproveReview] = useState(ticket.auto_approve_review)
  const [lifecycleConfig, setLifecycleConfig] = useState<TicketLifecycleConfig | null>(
    ticket.lifecycle_callbacks ?? null
  )
  const [verifyOverrides, setVerifyOverrides] = useState<VerifyOverrides | null>(
    ticket.verify_overrides ?? null
  )
  const [isSaving, setIsSaving] = useState(false)
  const [isRerunningGate, setIsRerunningGate] = useState(false)
  const rerunConditionGate = useKanbanStore((s) => s.rerunConditionGate)
  const lifecycle = useLifecycleActions(ticket.worktree_id)
  const iterateMaxIterations = useSettingsStore((s) => s.kanbanIterateLoopMaxIterations)
  const iterateFixPromptTemplate = useSettingsStore((s) => s.kanbanIterateLoopFixPromptTemplate)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const lifecycleDirty =
    JSON.stringify(lifecycleConfig ?? null) !==
    JSON.stringify(ticket.lifecycle_callbacks ?? null)
  const verifyOverridesDirty =
    JSON.stringify(verifyOverrides ?? null) !== JSON.stringify(ticket.verify_overrides ?? null)
  const isDirty =
    normalizeDraftText(title) !== normalizeDraftText(ticket.title) ||
    normalizeDraftText(description) !== normalizeDraftText(ticket.description) ||
    normalizeTicketAttachments(attachments) !== normalizeTicketAttachments(ticket.attachments) ||
    autoApproveReview !== ticket.auto_approve_review ||
    lifecycleDirty ||
    verifyOverridesDirty

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  const followUpTriggerColumn = useSettingsStore((s) => s.followUpTriggerColumn)

  // ── Dependency selectors ──────────────────────────────────────────
  // useShallow prevents infinite re-render loops by doing shallow equality
  // comparison on the returned array instead of Object.is reference check.
  const blockerTickets = useKanbanStore(
    useShallow((state) => {
      const blockerKeys = state.dependencyMap.get(ticketKey(ticket.project_id, ticket.id))
      if (!blockerKeys?.size) return [] as KanbanTicket[]
      const result: KanbanTicket[] = []
      for (const blockerKey of blockerKeys) {
        const blockerRef = parseTicketKey(blockerKey)
        const blocker = state.tickets
          .get(blockerRef.projectId)
          ?.find((t) => t.id === blockerRef.ticketId)
        if (blocker) result.push(blocker)
      }
      return result
    })
  )

  const dependentTickets = useKanbanStore(
    useShallow((state) => {
      const currentTicketKey = ticketKey(ticket.project_id, ticket.id)
      const result: KanbanTicket[] = []
      for (const [depKey, blockerKeys] of state.dependencyMap) {
        if (!blockerKeys.has(currentTicketKey)) continue
        const depRef = parseTicketKey(depKey)
        const dependent = state.tickets.get(depRef.projectId)?.find((t) => t.id === depRef.ticketId)
        if (dependent) result.push(dependent)
      }
      return result
    })
  )

  // Chained tickets share one branch/PR/worktree. A ticket is the chain's terminal
  // (last) step when nothing depends on it. Merge ships the shared branch and
  // Archive deletes it, so both are valid only on the terminal ticket — completing
  // the ticket (Move to Done) stays per-ticket. Mirrors PRNotificationStack.
  const isTerminalTicket = dependentTickets.length === 0

  // Load live PR state so merge-button guard works (hide if already merged/closed)
  useEffect(() => {
    if (lifecycle.hasAttachedPR) lifecycle.loadPRState()
  }, [lifecycle.hasAttachedPR])

  // ── Image paste/drop ───────────────────────────────────────────────
  const { isDragOver, handlePaste, handleDragOver, handleDragEnter, handleDragLeave, handleDrop } =
    useImagePaste({
      maxAttachments: MAX_ATTACHMENTS,
      currentCount: attachments.length,
      onAttach: (attachment) => setAttachments((prev) => [...prev, attachment])
    })

  const handleSave = useCallback(async () => {
    if (!title.trim() || isSaving) return
    setIsSaving(true)
    try {
      // Only write lifecycle_callbacks when the user actually edited it — sending
      // it on every save would clobber a null (seed-from-global) with a default.
      await updateTicket(ticket.id, ticket.project_id, {
        title: title.trim(),
        description: description.trim() || null,
        attachments: attachments.map((a) => ({ type: a.type, url: a.url, label: a.label })),
        auto_approve_review: autoApproveReview,
        ...(lifecycleDirty ? { lifecycle_callbacks: lifecycleConfig } : {}),
        ...(verifyOverridesDirty ? { verify_overrides: verifyOverrides } : {})
      })
      toast.success('Ticket updated')
      onClose()
    } catch (err) {
      // Surface the real reason (e.g. a zod "invalid enum value" from the RPC
      // validator) instead of a bare generic toast — a swallowed error here made
      // a Condition Gate `evaluate` schema-drift look like a mystery save failure.
      console.error('[KanbanTicketModal] updateTicket failed', err)
      toast.error('Failed to update ticket')
    } finally {
      setIsSaving(false)
    }
  }, [
    title,
    description,
    attachments,
    autoApproveReview,
    lifecycleDirty,
    lifecycleConfig,
    verifyOverridesDirty,
    verifyOverrides,
    isSaving,
    updateTicket,
    ticket.id,
    ticket.project_id,
    onClose
  ])

  const handleDelete = useCallback(async () => {
    try {
      await deleteTicket(ticket.id, ticket.project_id)
      toast.success('Ticket deleted')
      onClose()
    } catch {
      toast.error('Failed to delete ticket')
    }
  }, [deleteTicket, ticket.id, ticket.project_id, onClose])

  // Part D — manual continuation. Re-run Stage-2 (file-first verdict) → decide →
  // route (pass advance / fix launch round / block) without waiting for a settle.
  const handleRerunGate = useCallback(async () => {
    if (isRerunningGate) return
    setIsRerunningGate(true)
    try {
      const outcome = await rerunConditionGate(ticket.id, ticket.project_id)
      if (outcome === 'pass') toast.success('Condition Gate passed')
      else if (outcome === 'fix') toast.info('Condition Gate requested a fix — running fix round')
      else if (outcome === 'blocked') toast.warning('Condition Gate blocked — needs a human')
      // null → the store already surfaced a warning (unknown ticket / not a gate).
    } catch {
      toast.error('Failed to re-run Condition Gate')
    } finally {
      setIsRerunningGate(false)
    }
  }, [isRerunningGate, rerunConditionGate, ticket.id, ticket.project_id])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && title.trim()) {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave, title]
  )

  return (
    <div
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn('min-w-0', isDragOver && 'ring-2 ring-primary ring-offset-2 rounded-lg')}
    >
      <DialogHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DialogTitle>Edit Ticket</DialogTitle>
            {ticket.external_provider && ticket.external_url && (
              <button
                onClick={() => systemApi.openInChrome(ticket.external_url!)}
                className="transition-opacity hover:opacity-80"
                title={`Open ${getProviderLabel(ticket.external_provider)} #${ticket.external_id}`}
              >
                <ProviderIcon provider={ticket.external_provider} />
              </button>
            )}
          </div>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>Update ticket details.</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Title */}
        <div className="space-y-1.5">
          <label htmlFor="ticket-edit-title" className="text-sm font-medium text-foreground">
            Title <span className="text-destructive">*</span>
          </label>
          <Input
            id="ticket-edit-title"
            data-testid="ticket-edit-title-input"
            placeholder="What needs to be done?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="ticket-edit-description"
              className="text-sm font-medium text-foreground"
            >
              Description
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ticket-edit-preview-toggle"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={() => setShowPreview((prev) => !prev)}
            >
              {showPreview ? (
                <>
                  <EyeOff className="h-3.5 w-3.5" /> Edit
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" /> Preview
                </>
              )}
            </Button>
          </div>

          {showPreview ? (
            <div
              data-testid="ticket-edit-description-preview"
              className="min-h-[120px] rounded-md border border-input bg-muted/30 px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none break-words"
            >
              {description.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
              ) : (
                <p className="text-muted-foreground/60 italic">No description</p>
              )}
            </div>
          ) : (
            <Textarea
              id="ticket-edit-description"
              data-testid="ticket-edit-description-input"
              placeholder="Describe the ticket (supports markdown)..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="resize-y"
            />
          )}
        </div>

        <TicketGoalSection ticket={ticket} isEditMode />

        {/* Auto-approve plan (per-ticket; applies to Claude CLI plan-mode runs) */}
        <AutoApprovePlanToggle ticket={ticket} />

        {/* Attachments */}
        <TicketAttachmentEditor
          attachments={attachments}
          onChange={setAttachments}
          testIdPrefix="ticket-edit"
        />

        {/* Auto-approve Review (per-ticket) */}
        <AutoApproveReviewToggle
          checked={autoApproveReview}
          onChange={setAutoApproveReview}
          testId="ticket-edit-auto-approve-review-toggle"
        />

        {/* Iterate Loop — per-ticket lifecycle callbacks (review↔fix loop builder) */}
        <LifecycleCallbacksEditor
          value={lifecycleConfig}
          onChange={setLifecycleConfig}
          defaults={{
            maxIterations: iterateMaxIterations,
            fixPromptTemplate: iterateFixPromptTemplate
          }}
        />

        {/* Verification — per-ticket override of the three completion components */}
        <VerificationOverridesSection
          ticket={ticket}
          value={verifyOverrides}
          onChange={setVerifyOverrides}
        />

        {/* Last Condition-Gate run — so re-running the gate shows its result inline. */}
        {ticket.condition_gate_result && (
          <ConditionGateResultPanel result={ticket.condition_gate_result} />
        )}

        {/* Prompt queue (Claude CLI) — author a batch of follow-ups up front.
            Hidden on Done; renders nothing unless the feature is active. */}
        {ticket.column !== 'done' && <ClaudeCliQueueSection ticket={ticket} />}

        {/* Dependencies section */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">Dependencies</label>
          <div className="space-y-2">
            {/* Blockers */}
            {blockerTickets.length > 0 && (
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Blocked by:</span>
                {blockerTickets.map((blocker) => (
                  <div
                    key={`${blocker.project_id}:${blocker.id}`}
                    className="flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-muted/30"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isBlockerSatisfied(blocker.column, blocker.mode, followUpTriggerColumn) ? (
                        <span className="text-green-500 text-xs">&#10003;</span>
                      ) : (
                        <Lock className="h-3 w-3 text-amber-500" />
                      )}
                      <span className="text-sm truncate">{blocker.title}</span>
                    </div>
                    <button
                      onClick={() =>
                        useKanbanStore
                          .getState()
                          .removeDependency(
                            { projectId: ticket.project_id, ticketId: ticket.id },
                            { projectId: blocker.project_id, ticketId: blocker.id }
                          )
                      }
                      className="text-muted-foreground hover:text-foreground shrink-0"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Dependents */}
            {dependentTickets.length > 0 && (
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Depended on by:</span>
                {dependentTickets.map((dep) => (
                  <div
                    key={`${dep.project_id}:${dep.id}`}
                    className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted/30"
                  >
                    <span className="text-sm truncate min-w-0">{dep.title}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Add dependency button */}
            <button
              type="button"
              onClick={() => {
                useKanbanStore.getState().enterDependencyMode(ticket.id, ticket.project_id)
                onClose() // Close modal
              }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              Add dependency...
            </button>

            {/* Auto-launch indicator */}
            {ticket.pending_launch_config && (
              <div className="flex items-center gap-1.5 text-xs text-amber-500">
                <Zap className="h-3 w-3" />
                Auto-launch queued:{' '}
                {(() => {
                  try {
                    return JSON.parse(ticket.pending_launch_config).mode
                  } catch {
                    return 'unknown'
                  }
                })()}{' '}
                mode
              </div>
            )}
          </div>
        </div>
      </div>

      <DialogFooter className="flex items-center justify-between sm:justify-between flex-wrap gap-y-2">
        <div>
          {showDeleteConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-destructive">Delete this ticket?</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="ticket-edit-delete-confirm-btn"
                onClick={handleDelete}
              >
                Yes, delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ticket-edit-delete-btn"
              className="text-destructive hover:text-destructive"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {ticket.column === 'done' &&
            ticket.worktree_id &&
            isTerminalTicket &&
            lifecycle.isGitHub &&
            lifecycle.hasAttachedPR &&
            lifecycle.prLiveState?.state !== 'MERGED' &&
            lifecycle.prLiveState?.state !== 'CLOSED' && (
              <Button
                type="button"
                variant="outline"
                className="gap-1.5 bg-emerald-600/10 border-emerald-500/30 text-emerald-500 hover:bg-emerald-600/20"
                onClick={() => lifecycle.mergePR()}
                disabled={lifecycle.isMergingPR}
              >
                {lifecycle.isMergingPR ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitMerge className="h-3.5 w-3.5" />
                )}
                {lifecycle.isMergingPR ? 'Merging...' : 'Merge PR'}
              </Button>
            )}
          {ticket.column === 'done' &&
            ticket.worktree_id &&
            lifecycle.isGitHub &&
            lifecycle.hasAttachedPR &&
            lifecycle.prLiveState?.state !== 'MERGED' &&
            lifecycle.prLiveState?.state !== 'CLOSED' && (
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                onClick={() => lifecycle.rebasePR()}
                disabled={lifecycle.isRebasingPR}
              >
                {lifecycle.isRebasingPR ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitBranch className="h-3.5 w-3.5" />
                )}
                {lifecycle.isRebasingPR ? 'Rebasing...' : 'Rebase PR'}
              </Button>
            )}
          {ticket.column === 'done' &&
            ticket.worktree_id &&
            isTerminalTicket &&
            lifecycle.prMergeConflict && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5 bg-amber-600/10 border-amber-500/30 text-amber-500 hover:bg-amber-600/20"
              onClick={() =>
                lifecycle.autoResolvePrMergeConflict(ticket.current_session_id ?? undefined)
              }
              data-testid="pr-auto-resolve-button"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Auto Resolve Conflict &amp; Merge
            </Button>
          )}
          {ticket.column === 'done' && ticket.worktree_id && isTerminalTicket && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5 border-red-500/30 text-red-500 hover:bg-red-500/10"
              onClick={() => {
                onClose()
                lifecycle.archiveWorktree()
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </Button>
          )}
          {ticket.column === 'review' && isConditionGate(ticket.lifecycle_callbacks) && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5 border-blue-500/30 text-blue-500 hover:bg-blue-500/10"
              disabled={isRerunningGate}
              onClick={handleRerunGate}
              data-testid="rerun-condition-gate-btn"
            >
              <RefreshCw className={`h-3.5 w-3.5${isRerunningGate ? ' animate-spin' : ''}`} />
              {isRerunningGate ? 'Re-running gate…' : 'Re-run gate now'}
            </Button>
          )}
          <TicketRunButton state={runScriptState} testId="edit-run-btn" />
          <Button
            type="button"
            variant="outline"
            data-testid="ticket-edit-cancel-btn"
            onClick={onRequestClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="ticket-edit-save-btn"
            disabled={!title.trim() || isSaving}
            onClick={handleSave}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogFooter>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// PLAN REVIEW MODE
// ════════════════════════════════════════════════════════════════════

function PlanReviewModeContent({
  ticket,
  onClose,
  pendingPlan,
  sessionRecord,
  updateTicket,
  dualPane = false,
  worktreePath,
  opcSessionId,
  runScriptState
}: {
  ticket: KanbanTicket
  onClose: () => void
  pendingPlan: { requestId: string; planContent: string; toolUseID: string } | null
  sessionRecord: {
    worktree_id: string | null
    connection_id: string | null
    agent_sdk: string
    mode: FollowUpMode
  } | null
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  dualPane?: boolean
  worktreePath: string | null
  opcSessionId: string | null
  runScriptState: TicketRunScriptState
}) {
  const [isActioning, setIsActioning] = useState(false)
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('plan')
  const [isSending, setIsSending] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  const isConnectionSession = !!sessionRecord?.connection_id
  const isClaudeCliPlanSession = sessionRecord?.agent_sdk === 'claude-code-cli'
  const hasWorkingContext = !!(sessionRecord?.worktree_id || sessionRecord?.connection_id)

  const [slashCommands, setSlashCommands] = useState<{ name: string }[]>([])
  const hasSuperpowers = useMemo(
    () => slashCommands.some((c) => c.name === 'using-superpowers'),
    [slashCommands]
  )

  useEffect(() => {
    if (isClaudeCliPlanSession || !worktreePath || !opcSessionId) return
    let cancelled = false
    opencodeApi
      .commands(worktreePath, opcSessionId)
      .then(unwrapEnvelope)
      .then((result) => {
        if (!cancelled && result.success && result.commands) {
          setSlashCommands(result.commands)
        }
      })
      .catch((err) => {
        console.warn('[KanbanTicketModal] Failed to fetch slash commands:', err)
      })
    return () => {
      cancelled = true
    }
  }, [isClaudeCliPlanSession, worktreePath, opcSessionId])

  const planContent = pendingPlan?.planContent ?? ticket.description ?? ''

  const handleAttach = useCallback((file: AttachmentInput) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return prev
      }
      return [...prev, { id: crypto.randomUUID(), ...file }]
    })
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleDropFiles = useCallback(
    (files: FileList) => {
      if (isClaudeCliPlanSession) return
      for (const file of Array.from(files)) {
        if (attachments.length >= MAX_ATTACHMENTS) {
          toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
          break
        }
        if (isImageMime(file.type)) {
          const reader = new FileReader()
          reader.onload = () => {
            handleAttach({
              kind: 'data',
              name: file.name,
              mime: file.type,
              dataUrl: reader.result as string
            })
          }
          reader.readAsDataURL(file)
        } else {
          handleAttach({
            kind: 'path',
            name: file.name,
            mime: file.type || 'application/octet-stream',
            filePath: fileApi.getPathForFile(file)
          })
        }
      }
    },
    [handleAttach, attachments.length, isClaudeCliPlanSession]
  )

  const { isDragging } = useDropZone({ onDrop: handleDropFiles, containerRef: dropZoneRef })

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => (prev === 'build' ? 'plan' : 'build'))
  }, [])


  // ── Send followup (reject pending plan + iterate) ────────────────
  const handleSendFollowup = useCallback(async () => {
    if (
      (!followUpText.trim() && attachments.length === 0) ||
      !ticket.current_session_id ||
      isSending
    )
      return
    setIsSending(true)

    try {
      const sessionId = ticket.current_session_id
      const feedback = followUpText.trim()
      const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'

      // Reject the pending plan before sending the followup (mirrors SessionView)
      if (pendingPlan) {
        useSessionStore.getState().clearPendingPlan(sessionId)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

        if (isClaudeCode && (sessionRecord?.worktree_id || sessionRecord?.connection_id)) {
          let rejectPath: string | null = null
          if (sessionRecord.worktree_id) {
            rejectPath = findWorktreePathById(sessionRecord.worktree_id)
          } else if (sessionRecord.connection_id) {
            rejectPath =
              useConnectionStore
                .getState()
                .connections.find((c) => c.id === sessionRecord.connection_id)?.path ?? null
          }
          if (!rejectPath) {
            console.error(
              `[KanbanTicketModal] planReject: working path not found — worktree_id=${sessionRecord.worktree_id}, connection_id=${sessionRecord.connection_id}`
            )
            toast.error('Failed to reject plan: working path not found')
            return
          }
          await updateTicket(ticket.id, ticket.project_id, { plan_ready: false, mode: 'plan' })
          // The clearSessionStatus above wiped the busy state. Set it back to
          // 'planning' so the kanban card shows the progress bar while the
          // agent processes the rejection feedback.
          messageSendTimes.set(sessionId, Date.now())
          userExplicitSendTimes.set(sessionId, Date.now())
          snapshotTokenBaseline(sessionId)
          lastSendMode.set(sessionId, 'plan')
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'planning')
          toast.success('Plan rejected with feedback')
          onClose()

          // Send the rejection feedback to the session in background.
          // UI is already updated (plan cleared, status set, modal closed).
          sendFollowupToSession({
            sessionId,
            prompt: feedback,
            followUpMode,
            ticketId: ticket.id,
            attachments
          }).catch((err) => {
            console.error('[KanbanTicketModal] sendFollowupToSession failed:', err)
            const reason = err instanceof Error ? err.message : String(err)
            toast.error(`Failed to send followup: ${reason}`)
            useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
          })
          return
        }
      }

      // For non-Claude Code (or no pending plan): send as a regular followup.
      // Close modal immediately for instant UI feedback; run session in background.
      // Mark the session as busy NOW so the kanban card shows the progress bar
      // the moment the modal closes (sendFollowupToSession would set this too,
      // but only after async DB calls — the card would look idle in between).
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      lastSendMode.set(sessionId, completionSendMode(followUpMode))
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(followUpMode) ? 'planning' : 'working')

      await updateTicket(ticket.id, ticket.project_id, { mode: followUpMode, plan_ready: false })
      toast.success('Followup sent')
      onClose()

      sendFollowupToSession({
        sessionId,
        prompt: feedback,
        followUpMode,
        ticketId: ticket.id,
        attachments
      }).catch((err) => {
        console.error('[KanbanTicketModal] sendFollowupToSession failed:', err)
        const reason = err instanceof Error ? err.message : String(err)
        toast.error(`Failed to send followup: ${reason}`)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      })
    } catch (err) {
      console.error('[KanbanTicketModal] handleSendFollowup failed:', err)
      const reason = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to send followup: ${reason}`)
    } finally {
      setIsSending(false)
      setAttachments([])
    }
  }, [
    followUpText,
    followUpMode,
    ticket,
    isSending,
    pendingPlan,
    sessionRecord,
    updateTicket,
    onClose,
    attachments
  ])

  // ── Implement handler ─────────────────────────────────────────────
  const handleImplement = useCallback(async () => {
    if (!ticket.current_session_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      const pendingBeforeAction = pendingPlan
      const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      await useSessionStore.getState().setSessionMode(sessionId, 'build')
      lastSendMode.set(sessionId, 'build')
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)

      // Clear plan_ready badge — ticket is back to working
      await useKanbanStore
        .getState()
        .updateTicket(ticket.id, ticket.project_id, { plan_ready: false, mode: 'build' })
      notifyKanbanSessionSync(sessionId, { type: 'implement' })

      if (!isClaudeCode && pendingBeforeAction) {
        toast.success('Implementation started')
        onClose()

        sendFollowupToSession({
          sessionId,
          prompt: buildSdkPlanImplementationPrompt(
            sessionRecord?.agent_sdk,
            pendingBeforeAction.planContent
          ),
          followUpMode: 'build',
          ticketId: ticket.id
        }).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err)
          console.error('[KanbanTicketModal] background implement send failed:', err)
          toast.error(`Failed to start implementation: ${reason}`)
          useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        })
        return
      }

      // Claude Code sessions approve the real pending plan request.
      if (pendingBeforeAction && (sessionRecord?.worktree_id || sessionRecord?.connection_id)) {
        let approvePath: string | null = null
        if (sessionRecord.worktree_id) {
          approvePath = findWorktreePathById(sessionRecord.worktree_id)
        } else if (sessionRecord.connection_id) {
          approvePath =
            useConnectionStore
              .getState()
              .connections.find((c) => c.id === sessionRecord.connection_id)?.path ?? null
        }
        if (!approvePath) {
          console.error(
            `[KanbanTicketModal] handleImplement: working path not found — worktree_id=${sessionRecord.worktree_id}, connection_id=${sessionRecord.connection_id}`
          )
          toast.error('Failed to approve plan: working path not found')
          return
        }
        unwrapEnvelope(
          await opencodeApi.planApprove(approvePath, sessionId, pendingBeforeAction.requestId)
        )
      }

      toast.success('Implementation started')
      onClose()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error('[KanbanTicketModal] handleImplement failed:', err)
      toast.error(`Failed to start implementation: ${reason}`)
      useWorktreeStatusStore.getState().clearSessionStatus(ticket.current_session_id)
    } finally {
      setIsActioning(false)
    }
  }, [
    ticket.current_session_id,
    ticket.id,
    ticket.project_id,
    isActioning,
    pendingPlan,
    sessionRecord,
    onClose
  ])

  // ── Handoff handler ───────────────────────────────────────────────
  const handleHandoff = useCallback(
    async (override?: HandoffSelectionOverride) => {
      if (!ticket.current_session_id || !hasWorkingContext || isActioning) return
      setIsActioning(true)

      try {
        const sessionId = ticket.current_session_id
        const handoffGoalMode = override?.goalMode === true && override?.agentSdk === 'codex'
        useSessionStore.getState().clearPendingPlan(sessionId)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        lastSendMode.delete(sessionId)

        // Connection-session branch: eagerly start work even if the user stays on the board.
        if (sessionRecord?.connection_id) {
          if (worktreePath && opcSessionId) {
            useCommandApprovalStore.getState().clearSession(sessionId)
            unwrapEnvelope(await opencodeApi.abort(worktreePath, opcSessionId))
          }

          if (!worktreePath) {
            toast.error('Connection path unavailable')
            return
          }

          const connectionPath = worktreePath
          const sessionStore = useSessionStore.getState()
          const result = await sessionStore.createConnectionSession(
            sessionRecord.connection_id,
            override?.agentSdk,
            undefined,
            { autoFocus: false, modelOverride: override?.model }
          )
          if (!result.success || !result.session) {
            toast.error(result.error ?? 'Failed to create handoff session')
            return
          }

          const handoffPrompt = buildHandoffPrompt(planContent, override)
          const newSession = result.session
          const newSessionId = newSession.id
          const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')

          prepareTicketBuildSession(newSessionId, handoffGoalMode)
          if (newSession.agent_sdk === 'claude-code-cli') {
            registerHivePromptHandoff(sessionId, newSessionId)
            sessionStore.setPendingMessage(newSessionId, handoffPrompt)
          }

          const boardMode = useSettingsStore.getState().boardMode
          if (boardMode === 'sticky-tab') {
            sessionStore.setActiveSession(BOARD_TAB_ID)
          } else if (newSession.agent_sdk !== 'claude-code-cli') {
            sessionStore.setActiveConnection(sessionRecord.connection_id)
            sessionStore.setActiveConnectionSession(newSessionId)
          }

          onClose()
          void (async () => {
            await setModePromise
            if (newSession.agent_sdk === 'claude-code-cli') {
              bumpWorktreeLastMessage({ connectionId: sessionRecord.connection_id })
              // Claim the queued prompt before spawning so the new session view's
              // mount path (ClaudeCliSessionView.createClaudeTerminal) doesn't also
              // deliver it — sending a private copy here enters the prompt twice.
              const outboundPrompt = sessionStore.dequeuePendingMessage(newSessionId)
              const cliResult = unwrapEnvelope(
                await terminalApi.createClaudeCli(newSessionId, {
                  pendingPrompt: outboundPrompt
                })
              )
              if (!cliResult.success) {
                if (outboundPrompt) {
                  sessionStore.requeuePendingMessage(newSessionId, outboundPrompt)
                }
                throw new Error(cliResult.error ?? 'Failed to start Claude CLI handoff')
              }
              startHivePromptTelemetry({
                sessionId: newSessionId,
                prompt: handoffPrompt,
                worktreeId: null,
                mode: 'build'
              })
            } else {
              registerHivePromptHandoff(sessionId, newSessionId)
              await eagerHandoffStart(connectionPath, newSessionId, handoffPrompt, {
                connectionId: sessionRecord.connection_id
              })
            }
            toast.success('Handoff session started')
          })().catch((error) => {
            console.error(
              '[KanbanTicketModal] handoff (connection) background start failed:',
              error
            )
            toast.error('Failed to start handoff')
          })
          return
        }

        // Worktree-session branch. After the connection branch returns, TS can't
        // narrow worktree_id from hasWorkingContext alone — use a local const
        // rather than a non-null assertion so refactors of the branch above don't
        // silently break this one.
        const worktreeId = sessionRecord?.worktree_id
        if (!worktreeId) return

        const sessionStore = useSessionStore.getState()
        const result = await sessionStore.createSession(
          worktreeId,
          ticket.project_id,
          override?.agentSdk,
          undefined,
          { autoFocus: false, modelOverride: override?.model }
        )
        if (!result.success || !result.session) {
          toast.error(result.error ?? 'Failed to create handoff session')
          return
        }

        const handoffPrompt = buildHandoffPrompt(planContent, override)
        const newSession = result.session
        const newSessionId = newSession.id
        const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')
        const localWorktreePath = findWorktreePathById(worktreeId)
        if (!localWorktreePath) {
          toast.error('Could not find worktree path')
          return
        }

        prepareTicketBuildSession(newSessionId, handoffGoalMode)
        if (newSession.agent_sdk === 'claude-code-cli') {
          registerHivePromptHandoff(sessionId, newSessionId)
          sessionStore.setPendingMessage(newSessionId, handoffPrompt)
        }

        const boardMode = useSettingsStore.getState().boardMode
        if (boardMode === 'sticky-tab') {
          sessionStore.setActiveSession(BOARD_TAB_ID)
        } else if (newSession.agent_sdk !== 'claude-code-cli') {
          sessionStore.setActiveWorktree(worktreeId)
          sessionStore.setActiveSession(newSessionId)
        }

        onClose()
        void (async () => {
          await setModePromise
          if (newSession.agent_sdk === 'claude-code-cli') {
            bumpWorktreeLastMessage({ worktreeId })
            // Claim the queued prompt before spawning so the new session view's
            // mount path (ClaudeCliSessionView.createClaudeTerminal) doesn't also
            // deliver it — sending a private copy here enters the prompt twice.
            const outboundPrompt = sessionStore.dequeuePendingMessage(newSessionId)
            const cliResult = unwrapEnvelope(
              await terminalApi.createClaudeCli(newSessionId, {
                pendingPrompt: outboundPrompt
              })
            )
            if (!cliResult.success) {
              if (outboundPrompt) {
                sessionStore.requeuePendingMessage(newSessionId, outboundPrompt)
              }
              throw new Error(cliResult.error ?? 'Failed to start Claude CLI handoff')
            }
            startHivePromptTelemetry({
              sessionId: newSessionId,
              prompt: handoffPrompt,
              worktreeId,
              mode: 'build'
            })
          } else {
            registerHivePromptHandoff(sessionId, newSessionId)
            await eagerHandoffStart(localWorktreePath, newSessionId, handoffPrompt, { worktreeId })
          }
          toast.success('Handoff session started')
        })().catch((error) => {
          console.error('[KanbanTicketModal] handoff background start failed:', error)
          toast.error('Failed to start handoff')
        })
      } catch {
        toast.error('Failed to create handoff session')
      } finally {
        setIsActioning(false)
      }
    },
    [
      ticket,
      isActioning,
      planContent,
      onClose,
      hasWorkingContext,
      sessionRecord,
      worktreePath,
      opcSessionId
    ]
  )

  // Synchronously re-link the ticket to a new build session and (if needed) move it to
  // in_progress so the kanban board reflects the new work before the modal closes.
  const prepareTicketBuildSession = useCallback(
    (newSessionId: string, goalMode: boolean): void => {
      useKanbanStore
        .getState()
        .updateTicket(ticket.id, ticket.project_id, {
          current_session_id: newSessionId,
          plan_ready: false,
          mode: 'build',
          goal_mode: goalMode,
          goal_success_criteria: goalMode ? (ticket.goal_success_criteria ?? null) : null
        })
        .catch((err) => {
          console.error('[KanbanTicketModal] failed to relink supercharge session:', err)
          toast.error('Failed to attach the new session to the ticket')
        })

      if (ticket.column === 'todo' || ticket.column === 'review') {
        const kanbanStore = useKanbanStore.getState()
        const sortOrder = kanbanStore.computeSortOrder(
          kanbanStore.getTicketsByColumn(ticket.project_id, 'in_progress'),
          0
        )
        kanbanStore
          .moveTicket(ticket.id, ticket.project_id, 'in_progress', sortOrder)
          .catch((err) => {
            console.error(
              '[KanbanTicketModal] failed to move supercharged ticket to in_progress:',
              err
            )
            toast.error('Failed to move the ticket to in progress')
          })
      }
    },
    [ticket.id, ticket.project_id, ticket.column, ticket.sort_order, ticket.goal_success_criteria]
  )

  // ── Shared: eagerly connect, send /using-superpowers, queue follow-up for global listener ──
  const eagerSuperchargeStart = useCallback(
    async (
      worktreePath: string,
      newSessionId: string,
      bumpTarget: { worktreeId?: string | null; connectionId?: string | null }
    ) => {
      // Connect to OpenCode. Surface failure so the caller can alert the user — staying silent
      // here would leave optimistic UI state with no work running and no error feedback.
      const connectResult = unwrapEnvelope(await opencodeApi.connect(worktreePath, newSessionId))
      if (!connectResult.success || !connectResult.sessionId) {
        throw new Error('Failed to connect to supercharge session')
      }

      // Persist the opencode session ID to Zustand + DB
      useSessionStore.getState().setOpenCodeSessionId(newSessionId, connectResult.sessionId)
      await dbApi.session.update(newSessionId, {
        opencode_session_id: connectResult.sessionId
      })

      // Status / timing tracking — only after connect succeeds, so a failed connect does not
      // leave the session permanently marked 'working' on the worktree status store.
      messageSendTimes.set(newSessionId, Date.now())
      userExplicitSendTimes.set(newSessionId, Date.now())
      snapshotTokenBaseline(newSessionId)
      lastSendMode.set(newSessionId, 'build')
      useWorktreeStatusStore.getState().setSessionStatus(newSessionId, 'working')
      bumpWorktreeLastMessage(bumpTarget)

      // Queue the follow-up for the global idle listener to dispatch after /using-superpowers completes
      useSessionStore
        .getState()
        .setPendingFollowUpMessages(newSessionId, [
          'use the subagent development skill to implement the following plan:\n' + planContent
        ])

      // Send /using-superpowers — global listener handles follow-up on idle
      const model = resolveSessionModel(newSessionId)
      unwrapEnvelope(
        await opencodeApi.prompt(
          worktreePath,
          connectResult.sessionId,
          [{ type: 'text', text: '/using-superpowers' }],
          model
        )
      )
    },
    [planContent]
  )

  const eagerHandoffStart = useCallback(
    async (
      workingPath: string,
      newSessionId: string,
      handoffPrompt: string,
      bumpTarget: { worktreeId?: string | null; connectionId?: string | null }
    ) => {
      const connectResult = unwrapEnvelope(await opencodeApi.connect(workingPath, newSessionId))
      if (!connectResult.success || !connectResult.sessionId) {
        throw new Error('Failed to connect to handoff session')
      }

      useSessionStore.getState().setOpenCodeSessionId(newSessionId, connectResult.sessionId)
      await dbApi.session.update(newSessionId, {
        opencode_session_id: connectResult.sessionId
      })

      messageSendTimes.set(newSessionId, Date.now())
      userExplicitSendTimes.set(newSessionId, Date.now())
      snapshotTokenBaseline(newSessionId)
      lastSendMode.set(newSessionId, 'build')
      useWorktreeStatusStore.getState().setSessionStatus(newSessionId, 'working')
      bumpWorktreeLastMessage(bumpTarget)

      const model = resolveSessionModel(newSessionId)
      unwrapEnvelope(
        await opencodeApi.prompt(
          workingPath,
          connectResult.sessionId,
          [{ type: 'text', text: handoffPrompt }],
          model
        )
      )
      startHivePromptTelemetry({
        sessionId: newSessionId,
        prompt: handoffPrompt,
        worktreeId: bumpTarget.worktreeId,
        modelId: model?.modelID,
        providerId: model?.providerID,
        modelVariant: model?.variant,
        mode: 'build'
      })
    },
    []
  )

  // ── Supercharge handler (new branch) ────────────────────────────
  const handleSupercharge = useCallback(async () => {
    if (!ticket.current_session_id || !hasWorkingContext || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      lastSendMode.delete(sessionId)

      // Abort the original backend session so it stops spinning
      if (worktreePath && opcSessionId) {
        useCommandApprovalStore.getState().clearSession(sessionId)
        unwrapEnvelope(await opencodeApi.abort(worktreePath, opcSessionId))
      }

      // Connection-session branch: use eager start since modal closes to the board.
      if (sessionRecord?.connection_id) {
        if (!worktreePath) {
          toast.error('Connection path unavailable')
          return
        }
        // worktreePath is the connection path for connection sessions (parent resolves it).
        // Narrow to const so TS narrowing survives across the background IIFE closure.
        const connectionPath = worktreePath
        const sessionStore = useSessionStore.getState()
        const sessionResult = await sessionStore.createConnectionSession(
          sessionRecord.connection_id,
          undefined,
          undefined,
          { autoFocus: false }
        )
        if (!sessionResult.success || !sessionResult.session) {
          toast.error(sessionResult.error ?? 'Failed to create supercharge session')
          return
        }
        const newSessionId = sessionResult.session.id
        const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')

        prepareTicketBuildSession(newSessionId, ticket.goal_mode === true)
        onClose()

        // NOTE: On IIFE failure, the ticket is left re-linked to the new session (via
        // prepareTicketBuildSession above) — same failure mode as the worktree
        // branch below. We don't roll back because the error toast tells the user what
        // happened and retrying (via a new supercharge click) creates a fresh session.
        void (async () => {
          await setModePromise
          await eagerSuperchargeStart(connectionPath, newSessionId, {
            connectionId: sessionRecord.connection_id
          })
          toast.success('Supercharge session started')
        })().catch((error) => {
          console.error(
            '[KanbanTicketModal] supercharge (connection) background start failed:',
            error
          )
          toast.error('Failed to supercharge')
        })
        return
      }

      // Worktree-session branch. After the connection branch returns, TS can't
      // narrow worktree_id from hasWorkingContext alone — use a local const
      // rather than a non-null assertion so refactors of the branch above don't
      // silently break this one.
      const worktreeId = sessionRecord?.worktree_id
      if (!worktreeId) return

      // Look up worktree and project for duplication
      const worktree = findWorktreeById(worktreeId)
      if (!worktree) {
        toast.error('Could not find worktree')
        return
      }

      const project = useProjectStore.getState().projects.find((p) => p.id === worktree.project_id)
      if (!project) {
        toast.error('Could not find project')
        return
      }

      const extractedTitle = extractPlanTitle(planContent)
      const slug = extractedTitle ? canonicalizeTicketTitle(extractedTitle) : ''
      const nameHint = slug.length > 0 ? slug : undefined

      // Duplicate worktree
      const dupResult = await useWorktreeStore
        .getState()
        .duplicateWorktree(
          project.id,
          project.path,
          project.name,
          worktree.branch_name,
          worktree.path,
          nameHint
        )
      if (!dupResult.success || !dupResult.worktree) {
        toast.error(dupResult.error ?? 'Failed to duplicate worktree')
        return
      }

      // Create session in the new worktree
      const sessionStore = useSessionStore.getState()
      const sessionResult = await sessionStore.createSession(
        dupResult.worktree.id,
        project.id,
        undefined,
        undefined,
        { autoFocus: false }
      )
      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error ?? 'Failed to create supercharge session')
        return
      }

      const newSessionId = sessionResult.session.id
      const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')
      // Hoist into a const so TS narrowing survives across the background IIFE closure.
      const newWorktreeId = dupResult.worktree.id
      const newWorktreePath = dupResult.worktree.path

      prepareTicketBuildSession(newSessionId, ticket.goal_mode === true)
      onClose()

      // Finish session configuration and startup in the background so the modal can close
      // immediately. The success toast is deferred until the background work succeeds —
      // otherwise we'd announce success and then have to follow it with a failure toast.
      void (async () => {
        await setModePromise
        await eagerSuperchargeStart(newWorktreePath, newSessionId, { worktreeId: newWorktreeId })
        toast.success('Supercharge session started')
      })().catch((error) => {
        console.error('[KanbanTicketModal] supercharge background start failed:', error)
        toast.error('Failed to supercharge')
      })
    } catch {
      toast.error('Failed to supercharge')
    } finally {
      setIsActioning(false)
    }
  }, [
    ticket,
    isActioning,
    onClose,
    eagerSuperchargeStart,
    prepareTicketBuildSession,
    worktreePath,
    opcSessionId,
    hasWorkingContext,
    sessionRecord
  ])

  // ── Supercharge Local handler (same worktree, no duplication) ───
  const handleSuperchargeLocal = useCallback(async () => {
    if (!ticket.current_session_id || !ticket.worktree_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      lastSendMode.delete(sessionId)

      // Abort the original backend session so it stops spinning
      if (worktreePath && opcSessionId) {
        useCommandApprovalStore.getState().clearSession(sessionId)
        unwrapEnvelope(await opencodeApi.abort(worktreePath, opcSessionId))
      }

      const localWorktreePath = findWorktreePathById(ticket.worktree_id)
      if (!localWorktreePath) {
        toast.error('Could not find worktree path')
        return
      }

      // Create a new session in the SAME worktree
      const sessionStore = useSessionStore.getState()
      const sessionResult = await sessionStore.createSession(
        ticket.worktree_id,
        ticket.project_id,
        undefined,
        undefined,
        { autoFocus: false }
      )
      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error ?? 'Failed to create local supercharge session')
        return
      }

      const newSessionId = sessionResult.session.id
      const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')

      prepareTicketBuildSession(newSessionId, ticket.goal_mode === true)
      onClose()

      // Finish session configuration and startup in the background so the modal can close
      // immediately. The success toast is deferred until the background work succeeds —
      // otherwise we'd announce success and then have to follow it with a failure toast.
      void (async () => {
        await setModePromise
        await eagerSuperchargeStart(localWorktreePath, newSessionId, {
          worktreeId: ticket.worktree_id
        })
        toast.success('Local supercharge session started')
      })().catch((error) => {
        console.error('[KanbanTicketModal] local supercharge background start failed:', error)
        toast.error('Failed to supercharge locally')
      })
    } catch {
      toast.error('Failed to supercharge locally')
    } finally {
      setIsActioning(false)
    }
  }, [
    ticket,
    isActioning,
    onClose,
    eagerSuperchargeStart,
    prepareTicketBuildSession,
    worktreePath,
    opcSessionId
  ])

  return (
    <div ref={dropZoneRef} className="relative contents">
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 pr-6">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            {!dualPane && (
              <span className="truncate" title={ticket.title}>
                {ticket.title}
              </span>
            )}
            <span className="inline-flex shrink-0 items-center rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[11px] font-medium text-violet-500">
              Plan ready
            </span>
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>Review the plan and choose an action.</DialogDescription>
      </DialogHeader>

      <div
        data-testid="plan-review-content"
        className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-4 prose prose-sm dark:prose-invert max-w-none"
      >
        <MarkdownRenderer content={planContent} />
      </div>

      <TicketGoalSection ticket={ticket} />

      {/* Auto-approve plan (per-ticket; applies to the next plan-mode iteration) */}
      <AutoApprovePlanToggle ticket={ticket} />

      {/* Followup input — iterate on the plan */}
      <FollowupInput
        text={followUpText}
        onTextChange={setFollowUpText}
        attachments={attachments}
        onAttach={handleAttach}
        onRemoveAttachment={handleRemoveAttachment}
        followUpMode={followUpMode}
        onToggleMode={toggleMode}
        onSend={handleSendFollowup}
        isSending={isSending}
        placeholder="Iterate on the plan... (Enter to send)"
        testIdPrefix="plan-review"
        showInlineSendButton
        textareaRef={textareaRef}
      />

      {/* Drag-and-drop overlay */}
      {!isClaudeCliPlanSession && isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg border-2 border-dashed border-primary/50">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      {/* Run/Stop footer — always visible when the ticket has a worktree and
          the project has a run_script, regardless of whether the plan has arrived. */}
      {runScriptState.hasRunScript && (
        <DialogFooter className="flex-shrink-0 gap-1.5 flex-wrap">
          <TicketRunButton state={runScriptState} testId="plan-review-run-btn" />
        </DialogFooter>
      )}

      {/* Action buttons only visible when ExitPlanMode is awaiting approval
          (matches SessionView's showPlanReadyImplementFab gating on !!pendingPlan) */}
      {!!pendingPlan && (
        <DialogFooter className="flex-shrink-0 gap-1.5 flex-wrap">
          <HandoffSplitButton
            worktreeId={sessionRecord?.worktree_id ?? undefined}
            onHandoff={handleHandoff}
            testIdPrefix="plan-review"
            disabled={isActioning || !hasWorkingContext}
          />
          {!isClaudeCliPlanSession && !isConnectionSession && hasSuperpowers && (
            <Button
              type="button"
              data-testid="plan-review-supercharge-local-btn"
              disabled={isActioning || !hasWorkingContext}
              onClick={handleSuperchargeLocal}
              className="gap-1.5 border-violet-600 text-violet-600 hover:bg-violet-100 dark:hover:bg-violet-950"
              variant="outline"
            >
              <Bolt className="h-3.5 w-3.5" />
              Supercharge locally
            </Button>
          )}
          {!isClaudeCliPlanSession && hasSuperpowers && (
            <Button
              type="button"
              data-testid="plan-review-supercharge-btn"
              disabled={isActioning || !hasWorkingContext}
              onClick={handleSupercharge}
              className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
            >
              <Zap className="h-3.5 w-3.5" />
              Supercharge
            </Button>
          )}
          <Button
            type="button"
            data-testid="plan-review-implement-btn"
            disabled={isActioning}
            onClick={handleImplement}
            className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Hammer className="h-3.5 w-3.5" />
            Implement
          </Button>
        </DialogFooter>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// REVIEW MODE
// ════════════════════════════════════════════════════════════════════

function ReviewModeContent({
  ticket,
  onClose,
  moveTicket,
  updateTicket,
  dualPane = false,
  runScriptState
}: {
  ticket: KanbanTicket
  onClose: () => void
  moveTicket: (
    ticketId: string,
    projectId: string,
    column: 'todo' | 'in_progress' | 'review' | 'done',
    sortOrder: number
  ) => Promise<void>
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  dualPane?: boolean
  runScriptState: TicketRunScriptState
}) {
  const worktree = useMemo(
    () => (ticket.worktree_id ? findWorktreeById(ticket.worktree_id) : null),
    [ticket.worktree_id]
  )
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('build')
  const [isSending, setIsSending] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [resolvedWorktree, setResolvedWorktree] = useState<ResolvedModalWorktree | null>(worktree)
  const [resolvedBaseBranch, setResolvedBaseBranch] = useState<string | null>(null)
  const [diffSummary, setDiffSummary] = useState<ReviewTicketDiffFile[]>([])
  const [diffSummaryLoading, setDiffSummaryLoading] = useState(false)
  const [diffSummaryError, setDiffSummaryError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  const [autoApproveReview, setAutoApproveReview] = useState(ticket.auto_approve_review)
  useEffect(() => {
    setAutoApproveReview(ticket.auto_approve_review)
  }, [ticket.auto_approve_review])
  const handleToggleAutoApprove = useCallback(
    (next: boolean) => {
      setAutoApproveReview(next)
      void updateTicket(ticket.id, ticket.project_id, { auto_approve_review: next })
    },
    [ticket.id, ticket.project_id, updateTicket]
  )

  // Queue prompts (claude-code-cli): when active, a followup sent while work is
  // still in flight (or with prompts already queued) is queued instead of sent.
  const queueFeatureActive = useClaudeCliQueueFeatureActive(ticket)

  // Chained tickets share one branch/PR/worktree; a ticket is the chain's terminal
  // (last) step when nothing depends on it. Merge ships the shared branch, so it's
  // only valid on the terminal ticket (Move to Done stays per-ticket). Mirrors the
  // main modal footer and PRNotificationStack.
  const isTerminalTicket = useKanbanStore((s) => {
    const myKey = ticketKey(ticket.project_id, ticket.id)
    for (const blockers of s.dependencyMap.values()) {
      if (blockers.has(myKey)) return false
    }
    return true
  })

  // ── Manual "Verify completion" ────────────────────────────────────
  const recheckTicketCompletion = useKanbanStore((s) => s.recheckTicketCompletion)
  const completionVerdict = useKanbanStore(
    useCallback(
      (s) => s.completionVerdicts.get(ticketKey(ticket.project_id, ticket.id)) ?? null,
      [ticket.project_id, ticket.id]
    )
  )
  const [isVerifyingCompletion, setIsVerifyingCompletion] = useState(false)
  const handleVerifyCompletion = useCallback(async () => {
    setIsVerifyingCompletion(true)
    try {
      const verdict = await recheckTicketCompletion(ticket.id, ticket.project_id)
      if (!verdict) {
        // A null verdict is not an unexplained failure: the store already
        // surfaced the specific reason (no session, agent still working, or a
        // provider/parse error with a Retry). Adding a generic toast here just
        // double-toasted and misreported the cause — so stay quiet.
        return
      }
      if (verdict.needsInput) {
        toast.warning('Agent is waiting on you — moved back to In Progress')
      } else if (verdict.movedBack) {
        toast.warning('AI judged this incomplete — moved back to In Progress')
      } else {
        toast.success('AI judged this complete')
      }
    } finally {
      setIsVerifyingCompletion(false)
    }
  }, [recheckTicketCompletion, ticket.id, ticket.project_id])

  // ── Manual Condition-Gate re-run ──────────────────────────────────
  // Re-trigger the two-stage gate on demand (file-first verdict → decide →
  // route). Same action the auto-callback runs, `trigger:'manual'`; supersedes
  // any in-flight countdown. Colocated with the result panel below so "check it
  // again, and see how it decided" is one click from where the verdict shows.
  // NOT a passive re-check: pass advances (→ Done if auto-close), fix launches a
  // fix round, block routes needs-human — the toast says which.
  const rerunConditionGate = useKanbanStore((s) => s.rerunConditionGate)
  const isGateTicket = isConditionGate(ticket.lifecycle_callbacks)
  const [isRerunningGate, setIsRerunningGate] = useState(false)
  const handleRerunGate = useCallback(async () => {
    if (isRerunningGate) return
    setIsRerunningGate(true)
    try {
      const outcome = await rerunConditionGate(ticket.id, ticket.project_id)
      if (outcome === 'pass') toast.success('Condition Gate passed')
      else if (outcome === 'fix') toast.info('Condition Gate requested a fix — running fix round')
      else if (outcome === 'blocked') toast.warning('Condition Gate blocked — needs a human')
      // null → the store already surfaced a warning (unknown ticket / not a gate).
    } catch {
      toast.error('Failed to re-run Condition Gate')
    } finally {
      setIsRerunningGate(false)
    }
  }, [isRerunningGate, rerunConditionGate, ticket.id, ticket.project_id])

  const handleAttach = useCallback((file: AttachmentInput) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return prev
      }
      return [...prev, { id: crypto.randomUUID(), ...file }]
    })
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleDropFiles = useCallback(
    (files: FileList) => {
      for (const file of Array.from(files)) {
        if (attachments.length >= MAX_ATTACHMENTS) {
          toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
          break
        }
        if (isImageMime(file.type)) {
          const reader = new FileReader()
          reader.onload = () => {
            handleAttach({
              kind: 'data',
              name: file.name,
              mime: file.type,
              dataUrl: reader.result as string
            })
          }
          reader.readAsDataURL(file)
        } else {
          handleAttach({
            kind: 'path',
            name: file.name,
            mime: file.type || 'application/octet-stream',
            filePath: fileApi.getPathForFile(file)
          })
        }
      }
    },
    [handleAttach, attachments.length]
  )

  const { isDragging } = useDropZone({ onDrop: handleDropFiles, containerRef: dropZoneRef })
  const lifecycle = useLifecycleActions(ticket.worktree_id)
  const isCreatingPR = useGitStore((s) =>
    ticket.worktree_id ? s.creatingPRByWorktreeId.get(ticket.worktree_id) === true : false
  )
  const { lifecycleLoading } = usePinAndActivateSession(onClose)

  // Load live PR state so merge-button guard works (hide if already merged/closed)
  useEffect(() => {
    if (lifecycle.hasAttachedPR) lifecycle.loadPRState()
  }, [lifecycle.hasAttachedPR])

  // Display ticket description as context, with notice to view session for full conversation
  const reviewDescription = ticket.description ?? null

  // ── Resolve worktree for diff summary (base_branch lookup) ────────
  // NOTE: Run-script state lives on `runScriptState` (hoisted at the parent).
  // This effect is kept here because the diff summary below still needs the
  // resolved worktree to read `base_branch`.
  useEffect(() => {
    let cancelled = false

    if (!ticket.worktree_id) {
      setResolvedWorktree(null)
      return
    }

    if (worktree) {
      setResolvedWorktree(worktree)
      return
    }

    dbApi.worktree
      .get<Worktree>(ticket.worktree_id)
      .then((dbWorktree) => {
        if (!cancelled) {
          setResolvedWorktree(dbWorktree ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedWorktree(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [ticket.worktree_id, worktree])

  useEffect(() => {
    let cancelled = false

    if (!ticket.worktree_id || !resolvedWorktree) {
      setResolvedBaseBranch(null)
      return
    }

    ;(async () => {
      try {
        const defaultWorktrees = await dbApi.worktree.getActiveByProject<Worktree>(
          ticket.project_id
        )
        const defaultWt = defaultWorktrees.find((w) => w.is_default)
        if (!cancelled) {
          setResolvedBaseBranch(resolvedWorktree.base_branch ?? defaultWt?.branch_name ?? null)
        }
      } catch {
        if (!cancelled) {
          setResolvedBaseBranch(resolvedWorktree.base_branch ?? null)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [ticket.project_id, ticket.worktree_id, resolvedWorktree])

  useEffect(() => {
    let cancelled = false

    if (!dualPane || !resolvedWorktree?.path || !resolvedBaseBranch) {
      setDiffSummary([])
      setDiffSummaryError(null)
      setDiffSummaryLoading(false)
      return
    }

    const loadDiffSummary = async (): Promise<void> => {
      setDiffSummaryLoading(true)
      try {
        const result = await gitApi.getBranchDiffFiles(resolvedWorktree.path, resolvedBaseBranch)
        if (cancelled) return

        if (result.success) {
          setDiffSummary(result.files ?? [])
          setDiffSummaryError(null)
        } else {
          setDiffSummary([])
          setDiffSummaryError(result.error ?? 'Failed to load changed files')
        }
      } catch (error) {
        if (!cancelled) {
          setDiffSummary([])
          setDiffSummaryError(
            error instanceof Error ? error.message : 'Failed to load changed files'
          )
        }
      } finally {
        if (!cancelled) {
          setDiffSummaryLoading(false)
        }
      }
    }

    loadDiffSummary()

    const cleanup = gitApi.onStatusChanged((event) => {
      if (event.worktreePath === resolvedWorktree.path) {
        void loadDiffSummary()
      }
    })

    return () => {
      cancelled = true
      cleanup()
    }
  }, [dualPane, resolvedWorktree?.path, resolvedBaseBranch])

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => (prev === 'build' ? 'plan' : 'build'))
  }, [])


  // ── Send followup ─────────────────────────────────────────────────
  const handleSendFollowup = useCallback(async () => {
    if (
      (!followUpText.trim() && attachments.length === 0) ||
      !ticket.current_session_id ||
      isSending
    )
      return

    // Queue prompts (claude-code-cli): if the session is still busy, or prompts
    // are already lined up, enqueue this one instead of racing — it runs after
    // the ticket reaches Review and verifies complete. An idle session with an
    // empty queue falls through to the normal immediate send below (first prompt).
    if (queueFeatureActive) {
      const sessionId = ticket.current_session_id
      const status = useWorktreeStatusStore.getState().sessionStatuses[sessionId]?.status ?? null
      const queued =
        useKanbanStore.getState().promptQueues[ticketKey(ticket.project_id, ticket.id)] ?? []
      const busy = status === 'working' || status === 'planning'
      if (busy || queued.length > 0) {
        const value = followUpText.trim()
        if (!value) return
        if (attachments.length > 0) {
          toast.warning('Attachments are not supported for queued prompts — queuing text only')
        }
        useKanbanStore.getState().addQueuedPrompt(ticket.project_id, ticket.id, value)
        setFollowUpText('')
        setAttachments([])
        toast.success('Prompt queued — runs after this step verifies complete')
        void useKanbanStore.getState().dispatchClaudeCliQueueIfReady(ticket.project_id, ticket.id)
        return
      }
    }

    setIsSending(true)

    try {
      // Move ticket back to in_progress FIRST for immediate UI feedback.
      const kanbanStore = useKanbanStore.getState()
      const inProgressTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'in_progress')
      const sortOrder = kanbanStore.computeSortOrder(inProgressTickets, 0)
      await moveTicket(ticket.id, ticket.project_id, 'in_progress', sortOrder)

      // Capture values before closing modal
      const sessionId = ticket.current_session_id
      const prompt = followUpText.trim()
      const mode = followUpMode
      const ticketId = ticket.id
      const projectId = ticket.project_id
      const currentAttachments = [...attachments]

      // Mark the session as busy NOW so the kanban card shows the progress bar
      // the moment the modal closes (sendFollowupToSession would set this too,
      // but only after async DB calls — the card would look idle in between).
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      lastSendMode.set(sessionId, completionSendMode(mode))
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')

      await updateTicket(ticketId, projectId, { mode, plan_ready: false })
      toast.success('Followup sent')
      onClose()

      // Send followup in background. sendFollowupToSession awaits the full
      // Claude session, but the UI is already updated (ticket moved, modal
      // closed). Errors surface via the session error pipeline.
      sendFollowupToSession({
        sessionId,
        prompt,
        followUpMode: mode,
        ticketId,
        attachments: currentAttachments
      }).catch((err) => {
        console.error('[KanbanTicketModal] sendFollowupToSession failed:', err)
        const reason = err instanceof Error ? err.message : String(err)
        toast.error(`Failed to send followup: ${reason}`)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      })
    } catch (err) {
      console.error('[KanbanTicketModal] handleSendFollowup failed:', err)
      const reason = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to move ticket: ${reason}`)
    } finally {
      setIsSending(false)
      setAttachments([])
    }
  }, [
    followUpText,
    followUpMode,
    ticket,
    isSending,
    moveTicket,
    updateTicket,
    onClose,
    attachments,
    queueFeatureActive
  ])

  // ── Move to Done ──────────────────────────────────────────────────
  const handleMoveToDone = useCallback(async () => {
    // Merge-on-done: intercept for feature-branch worktrees
    if (ticket.worktree_id) {
      try {
        const worktree = await dbApi.worktree.get<Worktree>(ticket.worktree_id)
        if (worktree) {
          const defaultWorktrees = await dbApi.worktree.getActiveByProject<Worktree>(
            ticket.project_id
          )
          const defaultWt = defaultWorktrees.find((w) => w.is_default)
          const resolvedBaseBranch = worktree.base_branch ?? defaultWt?.branch_name

          if (resolvedBaseBranch && worktree.branch_name !== resolvedBaseBranch) {
            const kanbanStore = useKanbanStore.getState()
            const doneTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'done')
            const sortOrder = kanbanStore.computeSortOrder(doneTickets, 0)
            kanbanStore.setPendingDoneMove({
              ticketId: ticket.id,
              projectId: ticket.project_id,
              sortOrder
            })
            return
          }
        }
      } catch {
        // Fall through to normal move on error
      }
    }

    // Original logic
    try {
      const kanbanStore = useKanbanStore.getState()
      const doneTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'done')
      const sortOrder = kanbanStore.computeSortOrder(doneTickets, 0)
      await moveTicket(ticket.id, ticket.project_id, 'done', sortOrder)
      toast.success('Ticket moved to Done')
    } catch {
      toast.error('Failed to move ticket')
    }
  }, [ticket, moveTicket])

  return (
    <div ref={dropZoneRef} className="relative contents">
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 pr-6">
          <DialogTitle className="min-w-0 truncate" title={dualPane ? undefined : ticket.title}>
            {dualPane ? 'Review' : ticket.title}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-2">
            {lifecycle.hasAttachedPR && lifecycle.attachedPR && (
              <button
                onClick={() => lifecycle.openPRInBrowser()}
                className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/60 transition-colors"
              >
                <Github className="h-3 w-3" />#{lifecycle.attachedPR.number}
              </button>
            )}
            <JumpToSessionButton ticket={ticket} onClose={onClose} />
          </div>
        </div>
        <DialogDescription>Review the session output and provide followup.</DialogDescription>
      </DialogHeader>

      {!dualPane && (
        <div
          data-testid="review-content"
          className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-4 space-y-3"
        >
          {reviewDescription ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={reviewDescription} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Session completed.</p>
          )}
          <TicketGoalSection ticket={ticket} />
          <p data-testid="review-session-notice" className="text-xs text-muted-foreground/80">
            View the full session conversation by clicking &quot;Jump to session&quot; above.
          </p>
        </div>
      )}

      {dualPane && (
        <ReviewTicketDiffSummary
          baseBranch={resolvedBaseBranch}
          files={diffSummary}
          loading={diffSummaryLoading}
          error={diffSummaryError}
          onBaseBranchChange={
            resolvedWorktree?.id
              ? async (newBaseBranch) => {
                  const worktreeId = resolvedWorktree.id
                  try {
                    await dbApi.worktree.update(worktreeId, { base_branch: newBaseBranch })
                    setResolvedBaseBranch(newBaseBranch)
                    setResolvedWorktree((prev) =>
                      prev ? { ...prev, base_branch: newBaseBranch } : prev
                    )
                    toast.success('Base branch updated')
                  } catch {
                    toast.error('Failed to update base branch')
                  }
                }
              : undefined
          }
        />
      )}

      {/* Per-ticket auto-approve toggle (build tickets only) */}
      {ticket.mode === 'build' && (
        <div className="flex-shrink-0 rounded-md border border-border/60 bg-muted/20 p-3">
          <AutoApproveReviewToggle
            checked={autoApproveReview}
            onChange={handleToggleAutoApprove}
            testId="ticket-review-auto-approve-review-toggle"
          />
        </div>
      )}

      {/* Condition Gate result — durable record of whether the two-stage gate ran
          and how it decided (survives reload; shows regardless of ticket mode).
          The re-run button lives here (not just the edit-mode footer) so you can
          re-trigger the gate from where you read the verdict. */}
      {(ticket.condition_gate_result || isGateTicket) && (
        <div className="flex-shrink-0 space-y-2">
          {ticket.condition_gate_result && (
            <ConditionGateResultPanel result={ticket.condition_gate_result} />
          )}
          {isGateTicket && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 border-blue-500/30 text-blue-500 hover:bg-blue-500/10"
              disabled={isRerunningGate}
              onClick={handleRerunGate}
              data-testid="review-rerun-condition-gate-btn"
            >
              <RefreshCw className={`h-3.5 w-3.5${isRerunningGate ? ' animate-spin' : ''}`} />
              {isRerunningGate ? 'Re-running gate…' : 'Re-run gate now'}
            </Button>
          )}
        </div>
      )}

      {/* Manual AI completion check (build tickets only) */}
      {ticket.mode === 'build' && (
        <div className="flex-shrink-0 space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isVerifyingCompletion || !ticket.current_session_id}
            onClick={handleVerifyCompletion}
            data-testid="ticket-review-verify-completion-btn"
          >
            {isVerifyingCompletion ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileSearch className="h-3.5 w-3.5" />
            )}
            Verify completion with AI
          </Button>
          {completionVerdict && (
            <div
              data-testid="ticket-review-completion-verdict"
              className={`rounded-md border px-3 py-2 text-xs ${
                completionVerdict.complete && !completionVerdict.movedBack
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              }`}
            >
              <span className="font-medium">
                {completionVerdict.needsInput
                  ? 'Waiting on you'
                  : completionVerdict.complete && !completionVerdict.movedBack
                    ? 'Complete'
                    : 'Not complete'}{' '}
                ({Math.round(completionVerdict.confidence * 100)}% confident)
              </span>
              {completionVerdict.reason && (
                <span className="ml-1 text-foreground/70">— {completionVerdict.reason}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Prompt queue (Claude CLI) — pending follow-ups waiting on verification */}
      <ClaudeCliQueueSection ticket={ticket} />

      {/* Auto-approve plan (per-ticket; applies if a followup re-enters plan mode) */}
      <AutoApprovePlanToggle ticket={ticket} />

      {/* Followup input area */}
      <FollowupInput
        text={followUpText}
        onTextChange={setFollowUpText}
        attachments={attachments}
        onAttach={handleAttach}
        onRemoveAttachment={handleRemoveAttachment}
        followUpMode={followUpMode}
        onToggleMode={toggleMode}
        onSend={handleSendFollowup}
        isSending={isSending}
        placeholder={
          queueFeatureActive
            ? 'Provide followup instructions... (queues while busy; Enter to send)'
            : 'Provide followup instructions... (Enter to send)'
        }
        testIdPrefix="review"
        textareaRef={textareaRef}
      />

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg border-2 border-dashed border-primary/50">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      <DialogFooter className="flex-shrink-0 flex-wrap gap-y-2">
        <Button type="button" variant="outline" data-testid="review-cancel-btn" onClick={onClose}>
          Cancel
        </Button>
        <TicketRunButton state={runScriptState} testId="review-run-btn" />
        {ticket.worktree_id &&
          lifecycle.isGitHub &&
          !lifecycle.hasAttachedPR &&
          (isCreatingPR ? (
            <Button type="button" variant="outline" className="gap-1.5" disabled>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Creating PR...
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5"
              disabled={lifecycleLoading}
              onClick={() => {
                const worktreePath = findWorktreePathById(ticket.worktree_id!)
                if (worktreePath) {
                  useGitStore.getState().setCreatePRModalOpen(true, {
                    worktreeId: ticket.worktree_id!,
                    worktreePath,
                    ticketId: ticket.id
                  })
                } else {
                  toast.error('Could not find worktree path')
                }
              }}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              Create PR
            </Button>
          ))}
        {ticket.worktree_id &&
          isTerminalTicket &&
          lifecycle.isGitHub &&
          lifecycle.hasAttachedPR &&
          lifecycle.prLiveState?.state !== 'MERGED' &&
          lifecycle.prLiveState?.state !== 'CLOSED' && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5 bg-emerald-600/10 border-emerald-500/30 text-emerald-500 hover:bg-emerald-600/20"
              onClick={() => lifecycle.mergePR()}
              disabled={lifecycle.isMergingPR}
            >
              {lifecycle.isMergingPR ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitMerge className="h-3.5 w-3.5" />
              )}
              {lifecycle.isMergingPR ? 'Merging...' : 'Merge PR'}
            </Button>
          )}
        {ticket.worktree_id &&
          lifecycle.isGitHub &&
          lifecycle.hasAttachedPR &&
          lifecycle.prLiveState?.state !== 'MERGED' &&
          lifecycle.prLiveState?.state !== 'CLOSED' && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5"
              onClick={() => lifecycle.rebasePR()}
              disabled={lifecycle.isRebasingPR}
            >
              {lifecycle.isRebasingPR ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitBranch className="h-3.5 w-3.5" />
              )}
              {lifecycle.isRebasingPR ? 'Rebasing...' : 'Rebase PR'}
            </Button>
          )}
        {ticket.worktree_id && isTerminalTicket && lifecycle.prMergeConflict && (
          <Button
            type="button"
            variant="outline"
            className="gap-1.5 bg-amber-600/10 border-amber-500/30 text-amber-500 hover:bg-amber-600/20"
            onClick={() =>
              lifecycle.autoResolvePrMergeConflict(ticket.current_session_id ?? undefined)
            }
            data-testid="pr-auto-resolve-button"
          >
            <Wand2 className="h-3.5 w-3.5" />
            Auto Resolve Conflict &amp; Merge
          </Button>
        )}
        <Button
          type="button"
          data-testid="review-move-done-btn"
          variant="outline"
          onClick={handleMoveToDone}
        >
          Move to Done
        </Button>
        <Button
          type="button"
          data-testid="review-send-followup-btn"
          disabled={(!followUpText.trim() && attachments.length === 0) || isSending}
          onClick={handleSendFollowup}
          className={cn(
            'gap-1.5',
            followUpMode === 'build'
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-violet-600 hover:bg-violet-700 text-white'
          )}
        >
          <Send className="h-3.5 w-3.5" />
          {isSending ? 'Sending...' : 'Send'}
        </Button>
      </DialogFooter>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// ERROR MODE
// ════════════════════════════════════════════════════════════════════

function ErrorModeContent({
  ticket,
  onClose,
  dualPane = false,
  runScriptState
}: {
  ticket: KanbanTicket
  onClose: () => void
  dualPane?: boolean
  runScriptState: TicketRunScriptState
}) {
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('build')
  const [isSending, setIsSending] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const updateTicket = useKanbanStore((s) => s.updateTicket)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  // Look up session status entry for error details
  const sessionStatusEntry = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.sessionStatuses[ticket.current_session_id] ?? null
      },
      [ticket.current_session_id]
    )
  )

  const handleAttach = useCallback((file: AttachmentInput) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return prev
      }
      return [...prev, { id: crypto.randomUUID(), ...file }]
    })
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleDropFiles = useCallback(
    (files: FileList) => {
      for (const file of Array.from(files)) {
        if (attachments.length >= MAX_ATTACHMENTS) {
          toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
          break
        }
        if (isImageMime(file.type)) {
          const reader = new FileReader()
          reader.onload = () => {
            handleAttach({
              kind: 'data',
              name: file.name,
              mime: file.type,
              dataUrl: reader.result as string
            })
          }
          reader.readAsDataURL(file)
        } else {
          handleAttach({
            kind: 'path',
            name: file.name,
            mime: file.type || 'application/octet-stream',
            filePath: fileApi.getPathForFile(file)
          })
        }
      }
    },
    [handleAttach, attachments.length]
  )

  const { isDragging } = useDropZone({ onDrop: handleDropFiles, containerRef: dropZoneRef })

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => (prev === 'build' ? 'plan' : 'build'))
  }, [])


  // ── Send followup for error retry ─────────────────────────────────
  const handleSendFollowup = useCallback(async () => {
    if (
      (!followUpText.trim() && attachments.length === 0) ||
      !ticket.current_session_id ||
      isSending
    )
      return
    setIsSending(true)

    try {
      await sendFollowupToSession({
        sessionId: ticket.current_session_id,
        prompt: followUpText.trim(),
        followUpMode,
        ticketId: ticket.id,
        attachments
      })

      await updateTicket(ticket.id, ticket.project_id, { mode: followUpMode, plan_ready: false })
      toast.success('Retry sent')
      onClose()
    } catch {
      toast.error('Failed to send retry')
      // Reset session status so the kanban card stops showing a progress bar
      if (ticket.current_session_id) {
        useWorktreeStatusStore.getState().clearSessionStatus(ticket.current_session_id)
      }
    } finally {
      setIsSending(false)
      setAttachments([])
    }
  }, [followUpText, followUpMode, ticket, isSending, updateTicket, onClose, attachments])

  return (
    <div ref={dropZoneRef} className="relative contents">
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 pr-6">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            {!dualPane && (
              <span className="truncate" title={ticket.title}>
                {ticket.title}
              </span>
            )}
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-[11px] font-medium text-red-500">
              <AlertCircle className="h-3 w-3" />
              Error
            </span>
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>
          The session encountered an error. Send a followup to retry or correct.
        </DialogDescription>
      </DialogHeader>

      <div
        data-testid="error-info"
        className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400 space-y-1"
      >
        <p>
          The linked session reported an error. You can send a followup message to retry or provide
          corrections.
        </p>
        {sessionStatusEntry && (
          <p className="text-xs text-red-400/70" data-testid="error-status-detail">
            Status: {sessionStatusEntry.status}
            {sessionStatusEntry.word ? ` - ${sessionStatusEntry.word}` : ''}
            {sessionStatusEntry.durationMs
              ? ` (${Math.round(sessionStatusEntry.durationMs / 1000)}s ago)`
              : ''}
          </p>
        )}
        <p className="text-xs text-red-400/70">
          Session: {ticket.current_session_id}
          {' \u2014 use "Jump to session" for full details.'}
        </p>
      </div>

      {/* Followup input */}
      <FollowupInput
        text={followUpText}
        onTextChange={setFollowUpText}
        attachments={attachments}
        onAttach={handleAttach}
        onRemoveAttachment={handleRemoveAttachment}
        followUpMode={followUpMode}
        onToggleMode={toggleMode}
        onSend={handleSendFollowup}
        isSending={isSending}
        placeholder="Describe the fix or retry instructions... (Enter to send)"
        testIdPrefix="error"
      />

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg border-2 border-dashed border-primary/50">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      <DialogFooter>
        <TicketRunButton state={runScriptState} testId="error-run-btn" />
        <Button type="button" variant="outline" data-testid="error-cancel-btn" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="error-send-followup-btn"
          disabled={(!followUpText.trim() && attachments.length === 0) || isSending}
          onClick={handleSendFollowup}
          className={cn(
            'gap-1.5',
            followUpMode === 'build'
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-violet-600 hover:bg-violet-700 text-white'
          )}
        >
          <Send className="h-3.5 w-3.5" />
          {isSending ? 'Sending...' : 'Send'}
        </Button>
      </DialogFooter>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// QUESTION MODE
// ════════════════════════════════════════════════════════════════════

function QuestionModeContent({
  ticket,
  onClose,
  activeQuestion,
  dualPane = false,
  runScriptState
}: {
  ticket: KanbanTicket
  onClose: () => void
  activeQuestion: QuestionRequest
  dualPane?: boolean
  runScriptState: TicketRunScriptState
}) {
  const handleReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      try {
        let questionPath: string | null = null
        if (ticket.worktree_id) {
          questionPath = findWorktreePathById(ticket.worktree_id)
        } else if (ticket.current_session_id) {
          questionPath = (await findSessionById(ticket.current_session_id))?.workingPath ?? null
        }
        unwrapEnvelope(
          await opencodeApi.questionReply(requestId, answers, questionPath || undefined)
        )
        // Optimistically set session back to working so the progress bar resumes immediately
        if (ticket.current_session_id) {
          useWorktreeStatusStore
            .getState()
            .setSessionStatus(
              ticket.current_session_id,
              isPlanLike(ticket.mode) ? 'planning' : 'working'
            )
        }
        onClose()
      } catch (err) {
        console.error('Failed to send answer:', err)
        toast.error('Failed to send answer')
      }
    },
    [ticket.worktree_id, ticket.current_session_id, ticket.mode, onClose]
  )

  const handleReject = useCallback(
    async (requestId: string) => {
      try {
        let questionPath: string | null = null
        if (ticket.worktree_id) {
          questionPath = findWorktreePathById(ticket.worktree_id)
        } else if (ticket.current_session_id) {
          questionPath = (await findSessionById(ticket.current_session_id))?.workingPath ?? null
        }
        unwrapEnvelope(await opencodeApi.questionReject(requestId, questionPath || undefined))
        // Optimistically set session back to working so the progress bar resumes immediately
        if (ticket.current_session_id) {
          useWorktreeStatusStore
            .getState()
            .setSessionStatus(
              ticket.current_session_id,
              isPlanLike(ticket.mode) ? 'planning' : 'working'
            )
        }
        onClose()
      } catch (err) {
        console.error('Failed to dismiss question:', err)
        toast.error('Failed to dismiss question')
      }
    },
    [ticket.worktree_id, ticket.current_session_id, ticket.mode, onClose]
  )

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">Question from Agent</DialogTitle>
          <div className="flex items-center gap-2">
            <TicketRunButton
              state={runScriptState}
              testId="question-run-btn"
              className="h-7 px-2 text-xs"
            />
            <JumpToSessionButton ticket={ticket} onClose={onClose} />
          </div>
        </div>
        <DialogDescription>
          {dualPane ? 'An agent question needs your attention.' : ticket.title}
        </DialogDescription>
      </DialogHeader>
      <QuestionPrompt
        key={activeQuestion.id}
        request={activeQuestion}
        onReply={handleReply}
        onReject={handleReject}
      />
    </>
  )
}

// ════════════════════════════════════════════════════════════════════
// JUMP TO SESSION BUTTON
// ════════════════════════════════════════════════════════════════════

function JumpToSessionButton({
  ticket,
  onClose,
  label = 'Jump to session',
  testId = 'jump-to-session-btn'
}: {
  ticket: KanbanTicket
  onClose: () => void
  label?: string
  testId?: string
}) {
  const handleJump = useCallback(() => {
    if (!ticket.current_session_id) return

    // Switch off board view
    const kanbanStore = useKanbanStore.getState()
    if (kanbanStore.isBoardViewActive) {
      kanbanStore.toggleBoardView()
    }

    // Select the ticket's worktree and sync session store
    if (ticket.worktree_id) {
      useWorktreeStore.getState().selectWorktree(ticket.worktree_id)
      useSessionStore.getState().setActiveWorktree(ticket.worktree_id)
    }

    // Focus the session tab
    useSessionStore.getState().setActiveSession(ticket.current_session_id)

    onClose()
  }, [ticket.current_session_id, ticket.worktree_id, onClose])

  if (!ticket.current_session_id) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId}
      className="gap-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={handleJump}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {label}
    </Button>
  )
}
