import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Hammer, Map, Plus, GitBranch, Send, ChevronDown, Loader2, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { cn } from '@/lib/utils'
import { useKanbanStore, ticketKey, parseTicketKey } from '@/stores/useKanbanStore'
import { getChainTicketKeys, getChainExecutionOrder } from '@/lib/chain-utils'
import { isSessionOwnedByAnotherTicket } from '@/lib/session-ownership'
import { canLaunchWorktreeNow, getMaxParallelWorktrees } from '@/lib/worktree-concurrency'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { CodexFastToggle } from '@/components/sessions/CodexFastToggle'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { autoPinBaseWorktree } from '@/lib/auto-pin'
import {
  prepareWorktreeContextLaunch,
  type WorktreeContextScanTarget
} from '@/lib/worktree-context'
import {
  DEFAULT_CONTEXT_TEMPLATE,
  WORKTREE_CONTEXT_TOKENS
} from '@/lib/worktree-context-constants'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix, isPlanLike } from '@/lib/constants'
import { toast } from '@/lib/toast'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'
import { gitApi } from '@/api/git-api'
import { worktreeApi } from '@/api/worktree-api'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'
import type { KanbanTicket, Session } from '../../../../main/db/types'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { supportsGoalMode } from '@shared/types/agent-sdk'

// Stable empty array to avoid referential-inequality loops in Zustand selectors
const EMPTY_ARRAY: readonly never[] = []

// ── Types ───────────────────────────────────────────────────────────
type PickerMode = 'build' | 'plan' | 'super-plan'
type PickerAgentSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'

function completionSendMode(mode: PickerMode): 'build' | 'plan' {
  return isPlanLike(mode) ? 'plan' : 'build'
}

interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

interface WorktreePickerModalProps {
  ticket: KanbanTicket
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful send to complete the column move */
  onSendComplete?: () => void
  /** When true, only assigns worktree_id without creating a session or moving columns */
  preAssignOnly?: boolean
  /** When set, operates in connection mode — no worktree selection, uses connection path */
  connectionId?: string
  /** When true, serializes config as JSON on the ticket instead of creating a session */
  saveConfigOnly?: boolean
}

/** In-memory: last-chosen source branch per project (resets on app restart) */
const _lastSourceBranchByProject: Record<string, string> = {}

/** @internal — for test cleanup only */
export function _resetLastSourceBranch(): void {
  for (const key of Object.keys(_lastSourceBranchByProject)) {
    delete _lastSourceBranchByProject[key]
  }
}

// ── Prompt template builders ────────────────────────────────────────
function getModePrefix(mode: PickerMode): string {
  return mode === 'build'
    ? 'Please implement the following ticket.'
    : 'Please review the following ticket and create a detailed implementation plan.'
}

function swapModePrefix(text: string, fromMode: PickerMode, toMode: PickerMode): string {
  const fromPrefix = getModePrefix(fromMode)
  const toPrefix = getModePrefix(toMode)
  if (fromPrefix === toPrefix) return text // plan ↔ super-plan: same prefix
  if (text.startsWith(fromPrefix)) {
    return toPrefix + text.slice(fromPrefix.length) // swap prefix, keep the rest
  }
  return text // prefix not found: don't touch
}

function buildPrompt(mode: PickerMode, ticket: KanbanTicket): string {
  const prefix = getModePrefix(mode)
  const description = ticket.description ?? ''
  const attachments = (ticket.attachments ?? []) as Array<{
    type: string
    url: string
    label: string
  }>

  let attachmentsXml = ''
  if (attachments.length > 0) {
    const items: string[] = []
    for (const a of attachments) {
      if (a.type === 'image' || a.type === 'file') {
        items.push(`<file path="${a.url}">${a.label}</file>`)
      } else {
        items.push(`<link type="${a.type}" url="${a.url}">${a.label}</link>`)
      }
    }
    attachmentsXml = `\n<attachments>\n${items.join('\n')}\n</attachments>`
  }

  return `${prefix}\n\n<ticket title="${ticket.title}">${description}${attachmentsXml}</ticket>`
}

function wrapGoalPrompt(prompt: string, criteria: string): string {
  const stripped = prompt.replace(/^\/goal\s+/, '')
  return `/goal ${stripped}. Goal success criteria: ${criteria}`
}

function composePromptForSdk(
  mode: PickerMode,
  sessionAgentSdk: string | null | undefined,
  prompt: string,
  goalMode: boolean,
  goalCriteria: string,
  options: { claudeCli: boolean }
): string | null {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) return null

  const skipPrefix =
    options.claudeCli ||
    sessionAgentSdk === 'claude-code' ||
    sessionAgentSdk === 'codex' ||
    sessionAgentSdk === 'claude-code-cli'
  const modePrefix =
    mode === 'super-plan'
      ? getSuperPlanModePrefix(sessionAgentSdk)
      : mode === 'plan' && !skipPrefix
        ? PLAN_MODE_PREFIX
        : ''
  const fullPrompt = modePrefix + trimmedPrompt

  return goalMode && goalCriteria.trim()
    ? wrapGoalPrompt(fullPrompt, goalCriteria.trim())
    : fullPrompt
}

// Strip a SelectedModel down to the shape the prompt RPC accepts. The renderer's
// model objects carry an extra `agentSdk` field used for SDK routing, but the
// `opencodeOps.prompt` model schema is .strict() and rejects unknown keys — so
// passing the raw model fails with "RPC parameters failed validation".
function toRequestModel(
  model: { providerID: string; modelID: string; variant?: string } | undefined
): { providerID: string; modelID: string; variant?: string } | undefined {
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
}

// ── Component ───────────────────────────────────────────────────────
export function WorktreePickerModal({
  ticket,
  projectId,
  open,
  onOpenChange,
  onSendComplete,
  preAssignOnly = false,
  connectionId,
  saveConfigOnly = false
}: WorktreePickerModalProps) {
  const isConnectionMode = !!connectionId
  const [mode, setMode] = useState<PickerMode>('build')
  const [superArmed, setSuperArmed] = useState(false)
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [isNewWorktree, setIsNewWorktree] = useState(false)
  const [promptText, setPromptText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [goalMode, setGoalMode] = useState(false)
  const [goalCriteria, setGoalCriteria] = useState('')
  const [autoApproveReview, setAutoApproveReview] = useState(false)
  const [moveChain, setMoveChain] = useState(false)
  const [autoApprovePlan, setAutoApprovePlan] = useState(false)
  // When reusing an existing worktree, create a fresh ticket-named branch off a
  // chosen base (default branch by default) so this ticket's commits don't pile
  // onto whatever the worktree was last left on.
  const [createNewBranch, setCreateNewBranch] = useState(true)
  // When creating a NEW worktree, whether to run the project's setup script after
  // creation. Default on (current behavior); unchecking creates the worktree
  // without running setup (it can still be run later from the Setup tab).
  const [runSetup, setRunSetup] = useState(true)
  // Worktree context injection (claude-code-cli). Per-ticket toggle + editable
  // token template, both seeded from the global settings default on open.
  const [injectContext, setInjectContext] = useState(false)
  const [contextTemplate, setContextTemplate] = useState(DEFAULT_CONTEXT_TEMPLATE)
  const [contextPanelOpen, setContextPanelOpen] = useState(false)
  // New worktree: when true, check out the chosen branch directly (commits land
  // on it) instead of forking a fresh ticket-named branch off it.
  const [assignExistingBranch, setAssignExistingBranch] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [sourceBranch, setSourceBranch] = useState<string | null>(null) // null = default
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchFilter, setBranchFilter] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<{
    agentSdk?: PickerAgentSdk
    providerID: string
    modelID: string
    variant?: string
  } | null>(null)
  const [selectedSdk, setSelectedSdk] = useState<PickerAgentSdk | null>(null)

  // ── Store access ────────────────────────────────────────────────
  const worktrees = useWorktreeStore(
    useCallback((state) => state.worktreesByProject.get(projectId) ?? EMPTY_ARRAY, [projectId])
  )

  const ticketsForProject = useKanbanStore(
    useCallback((state) => state.tickets.get(projectId) ?? EMPTY_ARRAY, [projectId])
  )

  const updateTicket = useKanbanStore((state) => state.updateTicket)
  const createSession = useSessionStore((state) => state.createSession)
  const createWorktreeFromBranch = useWorktreeStore((state) => state.createWorktreeFromBranch)
  const syncWorktrees = useWorktreeStore((state) => state.syncWorktrees)

  const project = useProjectStore(
    useCallback((state) => state.projects.find((p) => p.id === projectId) ?? null, [projectId])
  )

  const defaultBranchName = useMemo(() => {
    const defaultWt = worktrees.find((w) => w.is_default)
    return defaultWt?.branch_name ?? 'main'
  }, [worktrees])

  const worktreeNamePreview = useMemo(() => {
    return canonicalizeTicketTitle(ticket.title)
  }, [ticket.title])

  // Only meaningful (and only shown) when the project actually has a setup script
  // and we're creating a new worktree — reused worktrees never run setup here.
  const hasSetupScript = useMemo(() => !!project?.setup_script?.trim(), [project?.setup_script])

  // ── SDK / Model resolution ──────────────────────────────────────
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'opencode'
  const codexFastMode = useSettingsStore((s) => s.codexFastMode)
  const codexFastModeAccepted = useSettingsStore((s) => s.codexFastModeAccepted)
  const autoApprovePlanDefault = useSettingsStore((s) => s.autoApprovePlanEnabled)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const defaultSdkNormalized = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
  const baseAgentSdk = selectedSdk ?? defaultSdkNormalized

  const autoResolvedModel = useMemo(() => {
    const settings = useSettingsStore.getState()
    // Priority 1: mode-specific default
    const modeModel = settings.getModelForMode(mode)
    if (modeModel && (!selectedSdk || modeModel.agentSdk === selectedSdk)) return modeModel
    // Priority 2: per-provider / global default
    return resolveModelForSdk(baseAgentSdk) ?? null
  }, [mode, baseAgentSdk, selectedSdk])

  const agentSdk =
    selectedSdk ?? selectedModel?.agentSdk ?? autoResolvedModel?.agentSdk ?? baseAgentSdk
  const goalAvailable = supportsGoalMode(agentSdk) && mode === 'build' && !preAssignOnly
  // Auto-approve only fires for the real CLI (PTY menu reading) when Claude
  // produces the ExitPlanMode approval menu. It's a per-ticket preference that
  // persists, so we expose it for any CLI launch (incl. build) — a build session
  // that later plans, or a plan-mode followup, will honor it.
  const autoApproveAvailable = agentSdk === 'claude-code-cli' && !preAssignOnly
  const availableSdkButtonCount = availableAgentSdks
    ? [
        availableAgentSdks.opencode,
        availableAgentSdks.claude,
        availableAgentSdks.codex,
        availableAgentSdks.claude
      ].filter(Boolean).length
    : 0

  // ── Count in-progress tickets per worktree ──────────────────────
  const ticketCountByWorktree = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of ticketsForProject) {
      if (t.column === 'in_progress' && t.worktree_id) {
        counts[t.worktree_id] = (counts[t.worktree_id] || 0) + 1
      }
    }
    return counts
  }, [ticketsForProject])

  // ── Resolve the rest of this ticket's dependency chain ──────────
  // Only meaningful when actually starting a session in a worktree (not in
  // pre-assign / save-config / connection modes — those have no concrete
  // worktree to share). Limited to tickets still in To Do, since the chain
  // members already started shouldn't be touched.
  const dependencyMap = useKanbanStore((state) => state.dependencyMap)
  const chainTodoTickets = useMemo(() => {
    if (preAssignOnly || saveConfigOnly || isConnectionMode) return [] as KanbanTicket[]
    const rootKey = ticketKey(ticket.project_id, ticket.id)
    const keys = getChainTicketKeys(dependencyMap, rootKey)
    const result: KanbanTicket[] = []
    for (const key of keys) {
      const ref = parseTicketKey(key)
      if (ref.projectId !== ticket.project_id) continue
      const chainTicket = ticketsForProject.find((t) => t.id === ref.ticketId)
      if (chainTicket && chainTicket.column === 'todo') result.push(chainTicket)
    }
    return result
  }, [
    dependencyMap,
    ticketsForProject,
    ticket.project_id,
    ticket.id,
    preAssignOnly,
    saveConfigOnly,
    isConnectionMode
  ])
  const showChainOption = chainTodoTickets.length > 0

  // ── Lazy branch loading ────────────────────────────────────────
  // Needed by both the New-worktree source picker and the reuse base picker.
  useEffect(() => {
    const needsBranches = !isConnectionMode && (isNewWorktree || !!selectedWorktreeId)
    // branches.length guard: only fetch once per modal-open cycle (reset clears branches on close)
    if (!needsBranches || !project?.path || branches.length > 0) return
    setBranchesLoading(true)
    gitApi
      .listBranchesWithStatus(project.path)
      .then((result) => {
        if (result.success) {
          setBranches(result.branches)
          const remembered = _lastSourceBranchByProject[projectId]
          if (remembered && !result.branches.some((b) => b.name === remembered)) {
            setSourceBranch(null)
          }
        }
      })
      .catch(() => {
        // IPC failure — branches stay empty, user sees "No branches found"
      })
      .finally(() => setBranchesLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewWorktree, selectedWorktreeId, isConnectionMode, project?.path])

  // ── Reset state when modal opens ────────────────────────────────
  useEffect(() => {
    if (open) {
      setMode('build')
      // Default to "New worktree" — it's the most common choice when starting work
      setSelectedWorktreeId(null)
      setIsNewWorktree(true)
      setPromptText(buildPrompt('build', ticket))
      setIsSending(false)
      setGoalMode(false)
      setGoalCriteria('')
      setAutoApproveReview(ticket.auto_approve_review)
      setMoveChain(false)
      setCreateNewBranch(true)
      setRunSetup(true)
      // Seed the per-ticket auto-approve toggle from the global default.
      setAutoApprovePlan(useSettingsStore.getState().autoApprovePlanEnabled)
      // Seed the per-ticket worktree-context injection from the global default.
      setInjectContext(useSettingsStore.getState().injectWorktreeContextEnabled)
      setContextTemplate(
        useSettingsStore.getState().worktreeContextTemplate || DEFAULT_CONTEXT_TEMPLATE
      )
      setContextPanelOpen(false)
      setSelectedModel(null)
      setSelectedSdk(null)
      setAssignExistingBranch(false)
      setSourceBranch(_lastSourceBranchByProject[projectId] ?? null)
      setBranches([])
      setBranchFilter('')
      setBranchPopoverOpen(false)
      // Refresh worktree list from git so the picker shows current state
      if (project?.path) {
        syncWorktrees(projectId, project.path, { force: true })
      }
    }
  }, [open, ticket, projectId, project?.path, syncWorktrees])

  // ── Branch filtering ───────────────────────────────────────────
  const filteredBranches = useMemo(() => {
    const lower = branchFilter.toLowerCase()
    return branches
      .filter((b) => b.name.toLowerCase().includes(lower))
      .sort((a, b) => {
        // Active (checked-out by a worktree) branches first
        if (a.isCheckedOut !== b.isCheckedOut) return a.isCheckedOut ? -1 : 1
        if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
        return a.name.localeCompare(b.name)
      })
  }, [branches, branchFilter])

  // For the New-worktree branch picker: when assigning an existing branch,
  // hide branches already checked out elsewhere (git allows one worktree per
  // branch, so they can't be assigned). Forking a new branch off them is fine.
  const newWorktreeBranchOptions = useMemo(
    () => (assignExistingBranch ? filteredBranches.filter((b) => !b.isCheckedOut) : filteredBranches),
    [assignExistingBranch, filteredBranches]
  )

  // ── Handle SDK change ───────────────────────────────────────────
  const handleSdkChange = useCallback((sdk: PickerAgentSdk) => {
    setSelectedSdk(sdk)
    setSelectedModel(null) // reset model — new SDK has different models
    if (!supportsGoalMode(sdk)) {
      setGoalMode(false)
      setGoalCriteria('')
    }
  }, [])

  // ── Handle mode toggle ──────────────────────────────────────────
  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next: PickerMode = prev === 'build' ? (superArmed ? 'super-plan' : 'plan') : 'build'
      setPromptText((current) => swapModePrefix(current, prev, next))
      setGoalMode(false)
      setGoalCriteria('')
      return next
    })
  }, [superArmed])

  // ── Handle SUPER toggle ─────────────────────────────────────────
  const toggleSuper = useCallback(() => {
    if (mode === 'plan') {
      setMode('super-plan')
      setSuperArmed(true)
      setGoalMode(false)
      setGoalCriteria('')
    } else if (mode === 'super-plan') {
      setMode('plan')
      setSuperArmed(false)
    }
  }, [mode])

  // ── Handle worktree selection ───────────────────────────────────
  const handleSelectWorktree = useCallback((wtId: string) => {
    setSelectedWorktreeId(wtId)
    setIsNewWorktree(false)
    setAssignExistingBranch(false)
    // Reuse base defaults to the repo default branch, independent of the
    // last-used New-worktree source branch.
    setSourceBranch(null)
  }, [])

  const handleSelectNewWorktree = useCallback(() => {
    setSelectedWorktreeId(null)
    setIsNewWorktree(true)
    setAssignExistingBranch(false)
    setSourceBranch(_lastSourceBranchByProject[projectId] ?? null)
  }, [projectId])

  // Assign-existing requires a concrete branch that isn't already checked out
  // somewhere (git allows only one worktree per branch).
  const assignBranchValid = useMemo(() => {
    if (!assignExistingBranch) return true
    if (!sourceBranch) return false
    const match = branches.find((b) => b.name === sourceBranch)
    return !match || !match.isCheckedOut
  }, [assignExistingBranch, sourceBranch, branches])

  // ── Create a fresh branch on a reused worktree ──────────────────
  // Branches off the chosen base (default branch, the worktree's own branch, or
  // any other ref) onto a ticket-named branch so this ticket starts clean.
  // Returns false (and toasts) on failure so the caller can abort before
  // creating a session on the wrong branch.
  const branchWorktreeFromBase = useCallback(
    async (worktreeId: string, baseBranch: string): Promise<boolean> => {
      const wt = Array.from(useWorktreeStore.getState().worktreesByProject.values())
        .flat()
        .find((w) => w.id === worktreeId)
      if (!wt?.path) return true
      const result = await worktreeApi.branchFromBase({
        worktreeId,
        worktreePath: wt.path,
        ticketTitle: ticket.title,
        baseBranch
      })
      if (!result.success) {
        toast.error(result.error || 'Failed to create the new branch')
        return false
      }
      if (result.branch) {
        useWorktreeStore.getState().updateWorktreeBranch(worktreeId, result.branch)
      }
      return true
    },
    [ticket.title]
  )

  // ── Send flow ───────────────────────────────────────────────────
  const goalCriteriaValid = !goalMode || goalCriteria.trim().length > 0
  const canSend =
    (isConnectionMode
      ? !isSending
      : (selectedWorktreeId !== null || isNewWorktree) && !isSending) &&
    goalCriteriaValid &&
    (isConnectionMode || !isNewWorktree || assignBranchValid)

  const handleSend = useCallback(async () => {
    if (!canSend) return
    setIsSending(true)

    // When context injection is on for claude-code-cli we defer the spawn until
    // setup resolves; gate the sidebar "working" status on that too.
    const willGateClaudeCli = injectContext && agentSdk === 'claude-code-cli'

    // Shared claude-code-cli launch. inject OFF → the raw prompt was already
    // enqueued at createSession; just dequeue + spawn (single-queue ownership).
    // inject ON → nothing was enqueued: set the gate, wait for setup, compose the
    // injected prompt, enqueue it, then spawn (the mount path's promptless create
    // is the harmless loser). On setup failure the gate goes `blocked` and the
    // session view's overlay offers "Launch anyway".
    const launchClaudeCli = async (
      sessionId: string,
      opts: {
        worktreeId: string | null
        scanTarget: WorktreeContextScanTarget | null
        basePrompt: string
        bump: () => void
      }
    ): Promise<void> => {
      if (mode === 'super-plan') {
        // Await so the persisted mode is committed before the main process reads
        // it in buildClaudeCliPtySpawn (createClaudeCli). Stays BEFORE the gate.
        await useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      if (willGateClaudeCli) {
        useSessionStore
          .getState()
          .setLaunchGate(sessionId, { state: 'awaiting', worktreeId: opts.worktreeId })
        const prepared = await prepareWorktreeContextLaunch({
          worktreeId: opts.worktreeId,
          scanTarget: opts.scanTarget,
          basePrompt: opts.basePrompt,
          template: contextTemplate || DEFAULT_CONTEXT_TEMPLATE
        })
        if (prepared.status === 'blocked') {
          // Block: surface the failure + "Launch anyway". Nothing is enqueued, so
          // there is nothing to requeue — the queue stays empty until the user acts.
          useSessionStore.getState().setLaunchGate(sessionId, {
            state: 'blocked',
            worktreeId: opts.worktreeId,
            error: prepared.error,
            launchAnywayPrompt: prepared.prompt
          })
          return
        }
        useSessionStore.getState().setPendingMessage(sessionId, prepared.prompt)
        useSessionStore
          .getState()
          .setLaunchGate(sessionId, { state: 'ready', worktreeId: opts.worktreeId })
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')
      }

      const outboundPrompt = useSessionStore.getState().dequeuePendingMessage(sessionId)
      opts.bump()
      try {
        const result = unwrapEnvelope(
          await terminalApi.createClaudeCli(sessionId, { pendingPrompt: outboundPrompt })
        )
        if (!result.success && outboundPrompt) {
          useSessionStore.getState().requeuePendingMessage(sessionId, outboundPrompt)
        }
      } catch (error) {
        if (outboundPrompt) {
          useSessionStore.getState().requeuePendingMessage(sessionId, outboundPrompt)
        }
        throw error
      } finally {
        if (willGateClaudeCli) {
          useSessionStore.getState().clearLaunchGate(sessionId)
        }
      }
    }

    // ── Connection mode path ──────────────────────────────────────
    if (isConnectionMode && connectionId) {
      try {
        // Create connection session
        const createConnectionSession = useSessionStore.getState().createConnectionSession
        const effectiveModel = selectedModel ?? autoResolvedModel ?? undefined
        const modelOverride = effectiveModel ? { ...effectiveModel, agentSdk } : undefined
        const cliPendingPrompt =
          agentSdk === 'claude-code-cli'
            ? composePromptForSdk(mode, agentSdk, promptText, goalMode, goalCriteria, {
                claudeCli: true
              })
            : null
        const createOptions = {
          ...(modelOverride ? { modelOverride } : {}),
          // When gating on setup, do NOT enqueue the raw prompt — the injected
          // prompt is enqueued only after setup resolves (leak-proof).
          ...(cliPendingPrompt && !willGateClaudeCli ? { pendingMessage: cliPendingPrompt } : {})
        }
        const sessionResult = await createConnectionSession(connectionId, agentSdk, mode, {
          ...createOptions
        })

        if (!sessionResult.success || !sessionResult.session) {
          toast.error(sessionResult.error || 'Failed to create session')
          setIsSending(false)
          return
        }

        const sessionId = sessionResult.session.id
        const sessionAgentSdk = sessionResult.session.agent_sdk

        // Seed the in-memory auto-approve override so the runtime effect picks it up.
        useSessionStore.getState().setAutoApprovePlan(sessionId, autoApprovePlan)

        // Set status tracking immediately so the sidebar shows spinning right away.
        messageSendTimes.set(sessionId, Date.now())
        userExplicitSendTimes.set(sessionId, Date.now())
        snapshotTokenBaseline(sessionId)
        lastSendMode.set(sessionId, completionSendMode(mode))
        // Defer the "working" status when gating on setup so the sidebar doesn't
        // imply the agent is running while it waits behind the overlay.
        if (!willGateClaudeCli) {
          useWorktreeStatusStore
            .getState()
            .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')
        }

        // Apply model override — scoped to THIS ticket's session only.
        // skipGlobalUpdate keeps the per-ticket pick from rewriting the global
        // per-SDK default (which would otherwise leak into every future ticket).
        if (selectedModel) {
          await useSessionStore
            .getState()
            .setSessionModel(sessionId, selectedModel, { skipGlobalUpdate: true })
        }

        // Update ticket — worktree_id stays null for connection sessions
        const sortOrder = useKanbanStore
          .getState()
          .computeSortOrder(
            useKanbanStore.getState().getTicketsByColumnForConnection(connectionId, 'in_progress'),
            0
          )

        await updateTicket(ticket.id, ticket.project_id, {
          current_session_id: sessionId,
          worktree_id: null,
          mode,
          column: 'in_progress',
          sort_order: sortOrder,
          plan_ready: false,
          goal_mode: goalMode,
          goal_success_criteria: goalMode ? goalCriteria.trim() : null,
          auto_approve_review: autoApproveReview,
          auto_approve_plan: autoApprovePlan
        })

        void autoPinBaseWorktree(ticket.project_id)

        // Trigger usage refresh so the board shows up-to-date usage (debounced in store)
        useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(agentSdk))

        // In sticky-tab mode, stay on the board instead of switching to the new session
        if (useSettingsStore.getState().boardMode === 'sticky-tab') {
          const { BOARD_TAB_ID } = await import('@/stores/useSessionStore')
          useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
        }

        // Close modal
        onSendComplete?.()
        onOpenChange(false)
        toast.success('Session started')

        if (sessionAgentSdk === 'claude-code-cli') {
          // Connection sessions have no per-worktree setup; the gate resolves
          // instantly (worktreeId null) and we inject port/env scanned from the
          // connection path.
          const connectionScanPath = useConnectionStore
            .getState()
            .connections.find((c) => c.id === connectionId)?.path
          await launchClaudeCli(sessionId, {
            worktreeId: null,
            scanTarget: connectionScanPath
              ? { id: connectionId, path: connectionScanPath }
              : null,
            basePrompt: cliPendingPrompt ?? '',
            bump: () => bumpWorktreeLastMessage({ connectionId })
          })
          return
        }

        // Connect to opencode using connection path
        const connectionPath = useConnectionStore
          .getState()
          .connections.find((c) => c.id === connectionId)?.path
        if (!connectionPath) return

        const connectResult = unwrapEnvelope(await opencodeApi.connect(connectionPath, sessionId))
        if (!connectResult.success || !connectResult.sessionId) {
          toast.error(connectResult.error || 'Failed to start session')
          return
        }

        useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
        await dbApi.session.update<Session>(sessionId, {
          opencode_session_id: connectResult.sessionId
        })

        // Send prompt
        if (promptText.trim()) {
          const outboundPrompt = composePromptForSdk(
            mode,
            sessionAgentSdk,
            promptText,
            goalMode,
            goalCriteria,
            { claudeCli: false }
          )
          if (!outboundPrompt) return
          const promptOptions = sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

          if (mode === 'super-plan') {
            useSessionStore.getState().setSessionMode(sessionId, 'plan')
          }
          if (!connectResult.sessionId) {
            throw new Error('Missing opencode session id')
          }

          bumpWorktreeLastMessage({ connectionId })
          startHivePromptTelemetry({
            sessionId,
            prompt: outboundPrompt,
            worktreeId: null,
            modelId: effectiveModel?.modelID,
            providerId: effectiveModel?.providerID,
            modelVariant: effectiveModel?.variant,
            mode
          })
          unwrapEnvelope(
            await opencodeApi.prompt(
              connectionPath,
              connectResult.sessionId,
              [{ type: 'text', text: outboundPrompt }],
              toRequestModel(effectiveModel),
              promptOptions
            )
          )
        }
        return // Done with connection path
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to start session')
      } finally {
        setIsSending(false)
      }
      return // Don't fall through to worktree logic
    }

    try {
      let worktreeId = selectedWorktreeId

      // ── Save config only path: serialize config, don't create session ─
      if (saveConfigOnly) {
        const pendingConfig = {
          worktree: isNewWorktree
            ? {
                type: 'new' as const,
                sourceBranch: sourceBranch ?? defaultBranchName,
                useExistingBranch: assignExistingBranch
              }
            : { type: 'existing' as const, worktreeId: worktreeId! },
          prompt: promptText.trim() || buildPrompt(mode, ticket),
          mode,
          model: selectedModel ?? null,
          sdk: agentSdk,
          codexFastMode,
          goalMode,
          goalSuccessCriteria: goalMode ? goalCriteria.trim() : null,
          autoApprovePlan,
          // New-worktree only: skip the setup script after create when unchecked.
          runSetup,
          injectContext,
          contextTemplate,
          // Reused-worktree only: branch off this base at launch time. Omitted
          // (reuse as-is) for new worktrees or when the toggle is off.
          ...(!isNewWorktree && createNewBranch
            ? { reuseBranchBase: sourceBranch ?? defaultBranchName }
            : {})
        }

        const sortOrder = useKanbanStore
          .getState()
          .computeSortOrder(
            useKanbanStore.getState().getTicketsByColumn(projectId, 'in_progress'),
            0
          )

        await updateTicket(ticket.id, projectId, {
          pending_launch_config: JSON.stringify(pendingConfig),
          column: 'in_progress',
          sort_order: sortOrder,
          mode,
          goal_mode: goalMode,
          goal_success_criteria: goalMode ? goalCriteria.trim() : null,
          auto_approve_review: autoApproveReview,
          auto_approve_plan: autoApprovePlan
        })

        onSendComplete?.()
        onOpenChange(false)
        toast.success('Launch config saved — will auto-launch when dependencies resolve')
        setIsSending(false)
        return
      }

      // ── Pre-assign path: only set worktree_id, no session ────────
      if (preAssignOnly) {
        // Create new worktree if needed
        if (isNewWorktree && project) {
          const targetBranch = sourceBranch ?? defaultBranchName
          _lastSourceBranchByProject[projectId] = targetBranch
          // Assigning an existing branch keeps the branch's own name; only a
          // forked branch is named after the ticket.
          const nameHint = assignExistingBranch
            ? undefined
            : canonicalizeTicketTitle(ticket.title) || undefined
          const result = await createWorktreeFromBranch(
            projectId,
            project.path,
            project.name,
            targetBranch,
            nameHint,
            assignExistingBranch,
            { runSetup }
          )
          if (!result.success || !result.worktree?.id) {
            toast.error(result.error || 'Failed to create worktree')
            setIsSending(false)
            return
          }
          worktreeId = result.worktree.id
        }

        if (!worktreeId) {
          toast.error('No worktree selected')
          setIsSending(false)
          return
        }

        // Reusing an existing worktree: branch off the chosen base first.
        if (!isNewWorktree && createNewBranch) {
          const checkedOut = await branchWorktreeFromBase(
            worktreeId,
            sourceBranch ?? defaultBranchName
          )
          if (!checkedOut) {
            setIsSending(false)
            return
          }
        }

        // If the worktree already has sessions, auto-attach the most recent one
        // so the ticket tracks session lifecycle (progress bar, auto-advance).
        const existingSessions = useSessionStore.getState().sessionsByWorktree.get(worktreeId) || []
        const activeSession = existingSessions[0]
        // ...but only if no OTHER ticket already owns that session. Binding two
        // tickets to one current_session_id makes session events (completed/error)
        // drive both at once — e.g. a blocked sibling rides the running ticket into
        // Review. When the session is already owned, attach the worktree only; this
        // ticket gets its own session when it launches.
        const sessionAlreadyOwned =
          !!activeSession &&
          isSessionOwnedByAnotherTicket(
            useKanbanStore.getState().tickets,
            activeSession.id,
            ticket.id
          )
        if (activeSession && !sessionAlreadyOwned) {
          await updateTicket(ticket.id, projectId, {
            worktree_id: worktreeId,
            current_session_id: activeSession.id,
            mode: (activeSession.mode as 'build' | 'plan') || 'build',
            plan_ready: false
          })
        } else {
          await updateTicket(ticket.id, projectId, { worktree_id: worktreeId })
        }
        onOpenChange(false)
        toast.success('Worktree assigned')
        return
      }

      // ── Concurrency gate: queue instead of launching when the project is at its
      // max-parallel-worktrees cap. The ticket keeps its launch config and stays put;
      // launchNextQueuedTickets auto-starts it once a running worktree leaves In Progress.
      if ((isNewWorktree || selectedWorktreeId) && !canLaunchWorktreeNow(projectId)) {
        const pendingConfig = {
          worktree: isNewWorktree
            ? {
                type: 'new' as const,
                sourceBranch: sourceBranch ?? defaultBranchName,
                useExistingBranch: assignExistingBranch
              }
            : { type: 'existing' as const, worktreeId: selectedWorktreeId! },
          prompt: promptText.trim() || buildPrompt(mode, ticket),
          mode,
          model: selectedModel ?? null,
          sdk: agentSdk,
          codexFastMode,
          goalMode,
          goalSuccessCriteria: goalMode ? goalCriteria.trim() : null,
          autoApprovePlan,
          // New-worktree only: skip the setup script after create when unchecked.
          runSetup
        }

        await updateTicket(ticket.id, projectId, {
          pending_launch_config: JSON.stringify(pendingConfig),
          mode,
          goal_mode: goalMode,
          goal_success_criteria: goalMode ? goalCriteria.trim() : null,
          auto_approve_review: autoApproveReview,
          auto_approve_plan: autoApprovePlan
        })

        onSendComplete?.()
        onOpenChange(false)
        const max = getMaxParallelWorktrees(projectId)
        toast.success(
          `Queued — project limit of ${max} running worktree${max === 1 ? '' : 's'} reached. ` +
            'Will auto-start when a slot frees.'
        )
        setIsSending(false)
        return
      }

      void autoPinBaseWorktree(projectId)

      // Create new worktree if needed
      if (isNewWorktree && project) {
        const targetBranch = sourceBranch ?? defaultBranchName
        _lastSourceBranchByProject[projectId] = targetBranch
        // Assigning an existing branch keeps the branch's own name; only a forked
        // branch is named after the ticket.
        const nameHint = assignExistingBranch
          ? undefined
          : canonicalizeTicketTitle(ticket.title) || undefined
        const result = await createWorktreeFromBranch(
          projectId,
          project.path,
          project.name,
          targetBranch,
          nameHint,
          assignExistingBranch,
          { runSetup }
        )
        if (!result.success || !result.worktree?.id) {
          toast.error(result.error || 'Failed to create worktree')
          setIsSending(false)
          return
        }
        worktreeId = result.worktree.id
      }

      if (!worktreeId) {
        toast.error('No worktree selected')
        setIsSending(false)
        return
      }

      // Reusing an existing worktree: branch off the chosen base first so this
      // ticket's work lands on a fresh, ticket-named branch.
      if (!isNewWorktree && createNewBranch) {
        const checkedOut = await branchWorktreeFromBase(
          worktreeId,
          sourceBranch ?? defaultBranchName
        )
        if (!checkedOut) {
          setIsSending(false)
          return
        }
      }

      // Create session in the selected worktree
      const effectiveModel = selectedModel ?? autoResolvedModel ?? undefined
      const modelOverride = effectiveModel ? { ...effectiveModel, agentSdk } : undefined
      const cliPendingPrompt =
        agentSdk === 'claude-code-cli'
          ? composePromptForSdk(mode, agentSdk, promptText, goalMode, goalCriteria, {
              claudeCli: true
            })
          : null
      const createOptions = {
        // This flow binds `ticket` to the new session itself (updateTicket below).
        // Skip the kanban auto-attach so the session can't ALSO be grabbed as some
        // OTHER orphan ticket's current_session_id when siblings share this worktree
        // (speckit reuses one worktree per spec) — that cross-wires two tickets to
        // one session and opens the wrong terminal from the ticket detail.
        skipKanbanAutoAttach: true,
        ...(modelOverride ? { modelOverride } : {}),
        // When gating on setup, do NOT enqueue the raw prompt — the injected
        // prompt is enqueued only after setup resolves (leak-proof).
        ...(cliPendingPrompt && !willGateClaudeCli ? { pendingMessage: cliPendingPrompt } : {})
      }
      const sessionResult = await createSession(
        worktreeId,
        projectId,
        agentSdk,
        mode,
        createOptions
      )

      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error || 'Failed to create session')
        setIsSending(false)
        return
      }

      const sessionId = sessionResult.session.id
      const sessionAgentSdk = sessionResult.session.agent_sdk

      // Seed the in-memory auto-approve override so the runtime effect picks it up.
      useSessionStore.getState().setAutoApprovePlan(sessionId, autoApprovePlan)

      // Set status tracking immediately so the sidebar shows spinning right away.
      // This must happen before any async work (connect, prompt) to avoid a race
      // where loadSessions wipes the session from sessionsByWorktree before the
      // status is set.
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      lastSendMode.set(sessionId, completionSendMode(mode))
      // Defer the "working" status when gating on setup so the sidebar doesn't
      // imply the agent is running while it waits behind the overlay.
      if (!willGateClaudeCli) {
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')
      }

      // Apply user's model override to the session if they explicitly picked one.
      // skipGlobalUpdate keeps this per-ticket pick scoped to the session and off
      // the global per-SDK default, so it can't bleed into future tickets.
      if (selectedModel) {
        await useSessionStore
          .getState()
          .setSessionModel(sessionId, selectedModel, { skipGlobalUpdate: true })
      }

      // ── Resolve where the head + chain land in In Progress ──────
      // When the whole chain comes along it should read top-to-bottom as
      // "first task (this head) → last task", as one contiguous block sitting
      // above the tickets already in the column. Order the remaining chain
      // tickets by execution order (blockers before dependents) and assign a
      // monotonically increasing block of sort_order values starting at the head.
      const willMoveChain = moveChain && chainTodoTickets.length > 0
      const rootKey = ticketKey(ticket.project_id, ticket.id)
      const orderedChainTickets = willMoveChain
        ? (() => {
            // NOTE: `Map` is shadowed by the lucide-react icon import in this
            // file, so index into the execution-order array directly.
            const execOrder = getChainExecutionOrder(dependencyMap, rootKey)
            const execRank = (id: string): number => {
              const idx = execOrder.indexOf(ticketKey(ticket.project_id, id))
              return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
            }
            return [...chainTodoTickets].sort((a, b) => execRank(a.id) - execRank(b.id))
          })()
        : []
      // Top-of-column anchor (the value a single ticket would get at index 0),
      // computed before the head moves so it reflects only the pre-existing
      // tickets. The block ends at this anchor and grows upward from the head.
      const anchorTop = useKanbanStore
        .getState()
        .computeSortOrder(useKanbanStore.getState().getTicketsByColumn(projectId, 'in_progress'), 0)
      const headSortOrder = anchorTop - orderedChainTickets.length

      // Update the ticket with session info and move to in_progress
      await updateTicket(ticket.id, projectId, {
        current_session_id: sessionId,
        worktree_id: worktreeId,
        mode,
        column: 'in_progress',
        sort_order: headSortOrder,
        plan_ready: false,
        goal_mode: goalMode,
        goal_success_criteria: goalMode ? goalCriteria.trim() : null,
        auto_approve_review: autoApproveReview,
        auto_approve_plan: autoApprovePlan
      })

      // ── Bring the whole dependency chain into In Progress on the same worktree ──
      // Each remaining chain ticket is moved to In Progress, pinned to this worktree,
      // and queued with a pending launch config that reuses the worktree — so it
      // auto-launches here (instead of spawning its own) once its blockers resolve.
      if (willMoveChain) {
        await Promise.all(
          orderedChainTickets.map((chainTicket, index) => {
            const chainConfig = {
              worktree: { type: 'existing' as const, worktreeId: worktreeId! },
              prompt: buildPrompt(mode, chainTicket),
              mode,
              model: selectedModel ?? null,
              sdk: agentSdk,
              codexFastMode,
              goalMode: false,
              goalSuccessCriteria: null,
              // Members inherit the head's context-injection choice so each one
              // gets its (shared) worktree context injected when it auto-launches.
              injectContext,
              contextTemplate
            }
            return updateTicket(chainTicket.id, projectId, {
              pending_launch_config: JSON.stringify(chainConfig),
              column: 'in_progress',
              // Head sits at headSortOrder; chain members follow in execution
              // order directly below it, all still above the pre-existing tickets.
              sort_order: headSortOrder + (index + 1),
              worktree_id: worktreeId!,
              mode,
              // Mirror the head ticket's Auto/Bypass Review Approve choice onto the
              // whole chain so each member auto-advances out of Review and the next
              // one launches automatically — keeping the chain running unattended.
              auto_approve_review: autoApproveReview
            })
          })
        )
      }

      // Trigger usage refresh so the board shows up-to-date usage (debounced in store)
      useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(agentSdk))

      // In sticky-tab mode, stay on the board instead of switching to the new session
      if (useSettingsStore.getState().boardMode === 'sticky-tab') {
        const { BOARD_TAB_ID } = await import('@/stores/useSessionStore')
        useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
      }

      // Close modal immediately — session starts in background
      onSendComplete?.()
      onOpenChange(false)
      toast.success('Session started')

      if (sessionAgentSdk === 'claude-code-cli') {
        const allWorktrees = Array.from(
          useWorktreeStore.getState().worktreesByProject.values()
        ).flat()
        const worktreeRow = allWorktrees.find((w) => w.id === worktreeId)
        await launchClaudeCli(sessionId, {
          worktreeId,
          scanTarget: worktreeRow
            ? {
                id: worktreeRow.id,
                path: worktreeRow.path,
                branch_name: worktreeRow.branch_name,
                // The store's worktree row omits base_branch; the launch context
                // knows it (new → chosen source, existing → repo default).
                base_branch: isNewWorktree ? (sourceBranch ?? defaultBranchName) : defaultBranchName
              }
            : null,
          basePrompt: cliPendingPrompt ?? '',
          bump: () => bumpWorktreeLastMessage({ worktreeId })
        })
        return
      }

      // ── Start the OpenCode session in the background ──────────
      // Resolve worktree path from the store
      const allWorktrees = Array.from(
        useWorktreeStore.getState().worktreesByProject.values()
      ).flat()
      const worktree = allWorktrees.find((w) => w.id === worktreeId)
      if (!worktree?.path) return

      // Connect to OpenCode to create the AI session
      const connectResult = unwrapEnvelope(await opencodeApi.connect(worktree.path, sessionId))
      if (!connectResult.success || !connectResult.sessionId) {
        toast.error(connectResult.error || 'Failed to start session')
        return
      }

      // Persist the opencodeSessionId to Zustand + DB
      useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
      await dbApi.session.update<Session>(sessionId, {
        opencode_session_id: connectResult.sessionId
      })

      // Send the prompt — apply plan mode prefix for opencode SDK
      if (promptText.trim()) {
        const outboundPrompt = composePromptForSdk(
          mode,
          sessionAgentSdk,
          promptText,
          goalMode,
          goalCriteria,
          { claudeCli: false }
        )
        if (!outboundPrompt) return
        const promptOptions = sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

        // Auto-revert super-plan → plan immediately (one-shot mode).
        // The prefix is already captured in fullPrompt above.
          if (mode === 'super-plan') {
            useSessionStore.getState().setSessionMode(sessionId, 'plan')
          }
          if (!connectResult.sessionId) {
            throw new Error('Missing opencode session id')
          }

          bumpWorktreeLastMessage({ worktreeId })
        startHivePromptTelemetry({
          sessionId,
          prompt: outboundPrompt,
          worktreeId,
          modelId: effectiveModel?.modelID,
          providerId: effectiveModel?.providerID,
          modelVariant: effectiveModel?.variant,
          mode
        })
        unwrapEnvelope(
          await opencodeApi.prompt(
            worktree.path,
            connectResult.sessionId,
            [{ type: 'text', text: outboundPrompt }],
            toRequestModel(effectiveModel),
            promptOptions
          )
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start session')
    } finally {
      setIsSending(false)
    }
  }, [
    canSend,
    selectedWorktreeId,
    isNewWorktree,
    project,
    createWorktreeFromBranch,
    sourceBranch,
    defaultBranchName,
    projectId,
    createSession,
    agentSdk,
    mode,
    promptText,
    updateTicket,
    ticket,
    onSendComplete,
    onOpenChange,
    preAssignOnly,
    saveConfigOnly,
    selectedModel,
    autoResolvedModel,
    codexFastMode,
    goalMode,
    goalCriteria,
    autoApproveReview,
    autoApprovePlan,
    injectContext,
    contextTemplate,
    isConnectionMode,
    connectionId,
    moveChain,
    chainTodoTickets,
    dependencyMap,
    createNewBranch,
    runSetup,
    branchWorktreeFromBase,
    assignExistingBranch
  ])

  // ── Mode toggle chip ────────────────────────────────────────────
  const ModeIcon = mode === 'build' ? Hammer : Map
  const modeLabel = mode === 'build' ? 'Build' : 'Plan'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="worktree-picker-modal"
        className="sm:max-w-[520px] flex flex-col overflow-hidden"
      >
        <DialogHeader className="space-y-2.5 pb-1 shrink-0">
          <DialogTitle className="text-base">
            {saveConfigOnly
              ? 'Pre-configure Launch'
              : preAssignOnly
                ? 'Assign Worktree'
                : 'Start Session'}
          </DialogTitle>
          <DialogDescription>
            {preAssignOnly
              ? 'Pre-assign a worktree to'
              : isConnectionMode
                ? 'Start a session for'
                : 'Pick a worktree for'}{' '}
            <span className="font-medium text-foreground">{ticket.title}</span>
          </DialogDescription>
          {/* Build/Plan chip toggle — below description to avoid overlapping the X close button */}
          {!preAssignOnly && (
            <div className="flex items-center gap-1.5">
              <button
                data-testid="wt-picker-mode-toggle"
                data-mode={mode}
                type="button"
                onClick={toggleMode}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors',
                  'border select-none',
                  mode === 'build'
                    ? 'bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
                    : 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
                )}
                title={`${modeLabel} mode`}
                aria-label={`Current mode: ${modeLabel}. Click to switch`}
              >
                <ModeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{modeLabel}</span>
              </button>
              <div
                className={cn(
                  'transition-all duration-200 overflow-hidden',
                  mode === 'plan' || mode === 'super-plan'
                    ? 'opacity-100 translate-x-0 max-w-[80px]'
                    : 'opacity-0 -translate-x-2 max-w-0 pointer-events-none'
                )}
              >
                <button
                  type="button"
                  onClick={toggleSuper}
                  aria-pressed={mode === 'super-plan'}
                  aria-label={`Super mode ${mode === 'super-plan' ? 'enabled' : 'disabled'}`}
                  data-testid="wt-picker-super-toggle"
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
                    'border select-none whitespace-nowrap',
                    mode === 'super-plan'
                      ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20 super-sparkle'
                      : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  SUPER
                </button>
              </div>
            </div>
          )}
        </DialogHeader>

        <div className="space-y-5 flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
          {/* ── Worktree list (hidden in connection mode) ────── */}
          {!isConnectionMode && (
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Worktree
              </label>
              <div
                data-testid="worktree-list"
                className="max-h-[200px] overflow-y-auto rounded-lg border border-border/60"
              >
                {/* "New worktree" option — always at top */}
                <button
                  data-testid="worktree-item-new"
                  type="button"
                  onClick={handleSelectNewWorktree}
                  className={cn(
                    'flex w-full items-center gap-3 px-3.5 py-2.5 text-sm transition-colors',
                    'border-b border-border/40',
                    'hover:bg-muted/30',
                    isNewWorktree && 'bg-primary/8 ring-1 ring-inset ring-primary/20'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      'bg-primary/10 text-primary'
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                  <span className="font-medium text-foreground">New worktree</span>
                </button>

                {isNewWorktree && (
                  <div className="border-b border-border/40 bg-muted/5">
                    <div className="flex items-center gap-2 px-3.5 py-2">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {assignExistingBranch ? 'branch' : 'from'}
                      </span>
                      <Popover open={branchPopoverOpen} onOpenChange={setBranchPopoverOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            data-testid="source-branch-trigger"
                            className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border border-border/60 hover:bg-muted/30 transition-colors"
                          >
                            <GitBranch className="h-3 w-3 text-muted-foreground" />
                            <span className="truncate max-w-[180px]">
                              {sourceBranch ??
                                (assignExistingBranch ? 'Select a branch…' : defaultBranchName)}
                            </span>
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-72 p-0" align="start">
                          <div className="p-2 border-b border-border/40">
                            <div className="relative">
                              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                              <Input
                                placeholder="Filter branches..."
                                value={branchFilter}
                                onChange={(e) => setBranchFilter(e.target.value)}
                                className="pl-7 h-8 text-xs"
                                autoFocus
                              />
                            </div>
                          </div>
                          <div className="max-h-[200px] overflow-y-auto py-1">
                            {branchesLoading ? (
                              <div className="flex items-center justify-center py-4">
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                              </div>
                            ) : newWorktreeBranchOptions.length === 0 ? (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                {assignExistingBranch
                                  ? 'No assignable branches (all are checked out)'
                                  : 'No branches found'}
                              </div>
                            ) : (
                              newWorktreeBranchOptions.map((branch) => (
                                <button
                                  type="button"
                                  key={`${branch.name}-${branch.isRemote}`}
                                  data-testid={`source-branch-${branch.name}`}
                                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-muted/30 transition-colors"
                                  onClick={() => {
                                    setSourceBranch(branch.name)
                                    _lastSourceBranchByProject[projectId] = branch.name
                                    setBranchPopoverOpen(false)
                                    setBranchFilter('')
                                  }}
                                >
                                  <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <span className="flex-1 truncate">{branch.name}</span>
                                  {branch.isRemote && (
                                    <span className="text-[10px] text-muted-foreground">remote</span>
                                  )}
                                  {branch.isCheckedOut && (
                                    <span className="text-[10px] text-primary">active</span>
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                      {!assignExistingBranch && worktreeNamePreview && (
                        <span className="ml-auto text-xs text-muted-foreground font-mono truncate max-w-[180px]">
                          {worktreeNamePreview}
                        </span>
                      )}
                    </div>

                    <label
                      className="flex items-start gap-2.5 px-3.5 py-2 border-t border-border/40 cursor-pointer select-none"
                      data-testid="assign-existing-branch-row"
                    >
                      <Checkbox
                        checked={assignExistingBranch}
                        onCheckedChange={(v) => {
                          const on = v === true
                          setAssignExistingBranch(on)
                          // The default branch is already checked out in the main
                          // worktree, so it can't be assigned — force a fresh pick.
                          if (on) setSourceBranch(null)
                          else setSourceBranch(_lastSourceBranchByProject[projectId] ?? null)
                        }}
                        data-testid="assign-existing-branch-checkbox"
                        className="mt-0.5"
                        aria-label="Assign an existing branch to the new worktree"
                      />
                      <span className="text-xs text-foreground">
                        Use the existing branch as-is
                        <span className="block text-muted-foreground">
                          Check out the selected branch directly so commits land on it, instead of
                          forking a new ticket-named branch off it.
                        </span>
                      </span>
                    </label>

                    {assignExistingBranch && !assignBranchValid && (
                      <p
                        className="px-3.5 pb-2 text-xs text-destructive"
                        data-testid="assign-existing-branch-error"
                      >
                        Pick a branch that isn&apos;t already checked out in another worktree.
                      </p>
                    )}
                  </div>
                )}

                {/* Existing worktrees */}
                {worktrees.map((wt) => {
                  const count = ticketCountByWorktree[wt.id] || 0
                  const isSelected = selectedWorktreeId === wt.id

                  return (
                    <button
                      key={wt.id}
                      data-testid={`worktree-item-${wt.id}`}
                      type="button"
                      onClick={() => handleSelectWorktree(wt.id)}
                      className={cn(
                        'flex w-full items-center gap-3 px-3.5 py-2.5 text-sm transition-colors',
                        'border-b border-border/40 last:border-b-0',
                        'hover:bg-muted/30',
                        isSelected && 'bg-primary/8 ring-1 ring-inset ring-primary/20'
                      )}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                        <GitBranch className="h-3.5 w-3.5" />
                      </span>
                      <span className="flex-1 truncate text-left font-medium text-foreground">
                        {wt.name}
                      </span>
                      {wt.is_default && (
                        <span className="rounded-full bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          default
                        </span>
                      )}
                      {count > 0 && (
                        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-500/10 px-1.5 text-[11px] font-medium text-blue-500">
                          {count}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Run setup script after creating a new worktree ── */}
          {!isConnectionMode && isNewWorktree && hasSetupScript && (
            <div
              className="flex items-start gap-2.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5"
              data-testid="run-setup-row"
            >
              <Checkbox
                checked={runSetup}
                onCheckedChange={(v) => setRunSetup(v === true)}
                data-testid="run-setup-checkbox"
                className="mt-0.5"
                aria-label="Run the project setup script after creating the worktree"
              />
              <span
                className="text-sm text-foreground cursor-pointer select-none"
                onClick={() => setRunSetup((v) => !v)}
              >
                Run setup command
                <span className="block text-xs text-muted-foreground">
                  Runs the project&apos;s Setup Script after the worktree is created. Uncheck to
                  create the worktree without running it — you can still run it later from the Setup
                  tab.
                </span>
              </span>
            </div>
          )}

          {/* ── Create a fresh branch off a chosen base when reusing ── */}
          {!isConnectionMode && !isNewWorktree && selectedWorktreeId && (
            <div
              className="rounded-md border border-border/50 bg-muted/20"
              data-testid="checkout-new-branch-row"
            >
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                <Checkbox
                  checked={createNewBranch}
                  onCheckedChange={(v) => setCreateNewBranch(v === true)}
                  data-testid="checkout-new-branch-checkbox"
                  className="mt-0.5"
                  aria-label="Create a new branch when reusing this worktree"
                />
                <span
                  className="text-sm text-foreground cursor-pointer select-none"
                  onClick={() => setCreateNewBranch((v) => !v)}
                >
                  Check out a new branch for this ticket
                  <span className="block text-xs text-muted-foreground">
                    Creates a fresh ticket-named branch off the base below so this ticket&apos;s
                    work doesn&apos;t pile onto the worktree&apos;s current branch. Uncheck to keep
                    the current branch.
                  </span>
                </span>
              </div>

              {createNewBranch && (
                <div className="flex items-center gap-2 px-3.5 py-2 border-t border-border/40">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">from</span>
                  <Popover open={branchPopoverOpen} onOpenChange={setBranchPopoverOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        data-testid="reuse-base-branch-trigger"
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border border-border/60 hover:bg-muted/30 transition-colors"
                      >
                        <GitBranch className="h-3 w-3 text-muted-foreground" />
                        <span className="truncate max-w-[180px]">
                          {sourceBranch ?? defaultBranchName}
                        </span>
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-0" align="start">
                      <div className="p-2 border-b border-border/40">
                        <div className="relative">
                          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                          <Input
                            placeholder="Filter branches..."
                            value={branchFilter}
                            onChange={(e) => setBranchFilter(e.target.value)}
                            className="pl-7 h-8 text-xs"
                            autoFocus
                          />
                        </div>
                      </div>
                      <div className="max-h-[200px] overflow-y-auto py-1">
                        {branchesLoading ? (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : filteredBranches.length === 0 ? (
                          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                            No branches found
                          </div>
                        ) : (
                          filteredBranches.map((branch) => (
                            <button
                              type="button"
                              key={`${branch.name}-${branch.isRemote}`}
                              data-testid={`reuse-base-branch-${branch.name}`}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-muted/30 transition-colors"
                              onClick={() => {
                                setSourceBranch(branch.name)
                                setBranchPopoverOpen(false)
                                setBranchFilter('')
                              }}
                            >
                              <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                              <span className="flex-1 truncate">{branch.name}</span>
                              {branch.isRemote && (
                                <span className="text-[10px] text-muted-foreground">remote</span>
                              )}
                              {branch.isCheckedOut && (
                                <span className="text-[10px] text-primary">active</span>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                  {worktreeNamePreview && (
                    <span className="ml-auto text-xs text-muted-foreground font-mono truncate max-w-[180px]">
                      {worktreeNamePreview}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Bring whole dependency chain along (same worktree) ── */}
          {showChainOption && (
            <div
              className="flex items-start gap-2.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5"
              data-testid="move-chain-row"
            >
              <Checkbox
                checked={moveChain}
                onCheckedChange={setMoveChain}
                data-testid="move-chain-checkbox"
                className="mt-0.5"
                aria-label="Move all chain tickets to In Progress on the same worktree"
              />
              <span
                className="text-sm text-foreground cursor-pointer select-none"
                onClick={() => setMoveChain((v) => !v)}
              >
                Move all chain tickets to In Progress too, running within the same worktree{' '}
                <span className="text-muted-foreground">({chainTodoTickets.length})</span>
              </span>
            </div>
          )}

          {/* ── Provider & Model picker (hidden in pre-assign mode) ── */}
          {!preAssignOnly && (
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Provider & Model
              </label>
              {/* SDK toggle — only when 2+ SDKs are available */}
              {availableAgentSdks && availableSdkButtonCount >= 2 && (
                <div className="flex gap-1.5" data-testid="sdk-toggle">
                  {availableAgentSdks.opencode && (
                    <button
                      type="button"
                      data-testid="sdk-toggle-opencode"
                      onClick={() => handleSdkChange('opencode')}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        agentSdk === 'opencode'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
                      )}
                    >
                      OpenCode
                    </button>
                  )}
                  {availableAgentSdks.claude && (
                    <button
                      type="button"
                      data-testid="sdk-toggle-claude-code"
                      onClick={() => handleSdkChange('claude-code')}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        agentSdk === 'claude-code'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
                      )}
                    >
                      Claude Code
                    </button>
                  )}
                  {availableAgentSdks.codex && (
                    <button
                      type="button"
                      data-testid="sdk-toggle-codex"
                      onClick={() => handleSdkChange('codex')}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        agentSdk === 'codex'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
                      )}
                    >
                      Codex
                    </button>
                  )}
                  {availableAgentSdks.claude && (
                    <button
                      type="button"
                      data-testid="sdk-toggle-claude-code-cli"
                      onClick={() => handleSdkChange('claude-code-cli')}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        agentSdk === 'claude-code-cli'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
                      )}
                    >
                      Claude CLI
                    </button>
                  )}
                </div>
              )}
              {goalAvailable && (
                <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground">Goal mode</span>
                    <Switch
                      checked={goalMode}
                      onCheckedChange={setGoalMode}
                      data-testid="goal-mode-toggle"
                    />
                  </div>
                  {goalMode && (
                    <div className="space-y-1.5">
                      <label
                        htmlFor="goal-success-criteria"
                        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                      >
                        Success criteria <span className="text-destructive">*</span>
                      </label>
                      <Textarea
                        id="goal-success-criteria"
                        value={goalCriteria}
                        onChange={(e) => setGoalCriteria(e.target.value)}
                        placeholder="What does success look like?"
                        data-testid="goal-success-criteria"
                        rows={3}
                        className="resize-y text-sm"
                      />
                      {goalCriteria.trim().length === 0 && (
                        <p className="text-xs text-destructive">Required</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {mode === 'build' && (
                <div className="space-y-1.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground">Auto-approve Review</span>
                    <Switch
                      checked={autoApproveReview}
                      onCheckedChange={setAutoApproveReview}
                      data-testid="auto-approve-review-toggle"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When this ticket settles in Review, auto-commit it and — if another ticket
                    depends on it — advance it to Done so the next chain ticket auto-starts. Runs
                    after the global wait time (Settings → General).
                  </p>
                </div>
              )}
              {autoApproveAvailable && (
                <div className="space-y-1.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground">Auto-approve plan</span>
                    <Switch
                      checked={autoApprovePlan}
                      onCheckedChange={setAutoApprovePlan}
                      data-testid="auto-approve-plan-toggle"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {autoApprovePlanDefault
                      ? 'On by default (set in Settings).'
                      : 'When Claude finishes planning, auto-pick the menu option matching your Settings text.'}
                  </p>
                </div>
              )}
              {agentSdk === 'claude-code-cli' && (
                <div className="space-y-1.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground">Worktree context</span>
                    <Switch
                      checked={injectContext}
                      onCheckedChange={setInjectContext}
                      data-testid="inject-context-toggle"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Wait for the worktree&apos;s setup script to finish, then inject its live
                    context (port, URL, branch, notes, setup output, env) into the first prompt.
                  </p>
                  {injectContext && (
                    <div className="space-y-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => setContextPanelOpen((open) => !open)}
                        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        data-testid="inject-context-template-toggle"
                      >
                        <ChevronDown
                          className={cn(
                            'h-3 w-3 transition-transform',
                            contextPanelOpen ? '' : '-rotate-90'
                          )}
                        />
                        Edit template
                      </button>
                      {contextPanelOpen && (
                        <>
                          <Textarea
                            data-testid="inject-context-template"
                            value={contextTemplate}
                            onChange={(e) => setContextTemplate(e.target.value)}
                            rows={8}
                            className="resize-y font-mono text-xs leading-relaxed"
                          />
                          <div className="flex flex-wrap gap-1">
                            {WORKTREE_CONTEXT_TOKENS.map((token) => (
                              <code
                                key={token}
                                className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
                              >
                                {`{{${token}}}`}
                              </code>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="min-w-0">
                  <ModelSelector
                    value={selectedModel ?? autoResolvedModel}
                    onChange={setSelectedModel}
                    agentSdkOverride={
                      selectedModel?.agentSdk ?? autoResolvedModel?.agentSdk ?? agentSdk
                    }
                  />
                </div>
                {agentSdk === 'codex' && (
                  <div className="shrink-0">
                    <CodexFastToggle
                      enabled={codexFastMode}
                      accepted={codexFastModeAccepted}
                      onToggle={() => updateSetting('codexFastMode', !codexFastMode)}
                      onAccept={() => updateSetting('codexFastModeAccepted', true)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Prompt preview / editor (hidden in pre-assign mode) ── */}
          {!preAssignOnly && (
            <div className="space-y-2">
              <label
                htmlFor="wt-picker-prompt-input"
                className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Prompt
              </label>
              <Textarea
                id="wt-picker-prompt-input"
                ref={promptRef}
                data-testid="wt-picker-prompt"
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={6}
                className="resize-y font-mono text-xs leading-relaxed"
                placeholder="Enter prompt for the session..."
              />
            </div>
          )}
        </div>

        <DialogFooter className="pt-1 shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="wt-picker-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="wt-picker-send-btn"
            disabled={!canSend}
            onClick={handleSend}
            className={cn(
              'gap-1.5',
              preAssignOnly
                ? ''
                : mode === 'build'
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-violet-600 hover:bg-violet-700 text-white'
            )}
          >
            {preAssignOnly ? (
              <>
                <GitBranch className="h-3.5 w-3.5" />
                {isSending ? 'Assigning...' : 'Assign'}
              </>
            ) : saveConfigOnly ? (
              <>
                <Send className="h-3.5 w-3.5" />
                {isSending ? 'Saving...' : 'Save & Queue'}
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                {isSending ? 'Starting...' : 'Send'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
