import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix, isPlanLike } from '@/lib/constants'
import { toast } from '@/lib/toast'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'
import { worktreeApi } from '@/api/worktree-api'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'
import { autoPinBaseWorktree } from '@/lib/auto-pin'
import {
  prepareWorktreeContextLaunch,
  type WorktreeContextScanTarget
} from '@/lib/worktree-context'
import { DEFAULT_CONTEXT_TEMPLATE } from '@/lib/worktree-context-constants'

type AutoLaunchMode = 'build' | 'plan' | 'super-plan'

interface AutoLaunchTicket {
  id: string
  project_id: string
  title: string
  pending_launch_config: string | null
}

interface PendingLaunchConfig {
  worktree: { type: 'new'; sourceBranch: string } | { type: 'existing'; worktreeId: string }
  prompt: string
  mode: AutoLaunchMode
  model: { providerID: string; modelID: string; variant?: string } | null
  sdk: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'
  codexFastMode: boolean
  goalMode: boolean
  goalSuccessCriteria: string | null
  autoApprovePlan: boolean
  /**
   * Reused-worktree only: when set, branch off this base ref onto a fresh
   * ticket-named branch before launching. Absent = reuse the worktree as-is.
   */
  reuseBranchBase?: string
  /** claude-code-cli: gate the spawn on setup + inject the worktree context. */
  injectContext?: boolean
  /** claude-code-cli: editable token template used when injectContext is on. */
  contextTemplate?: string
}

function wrapGoalPrompt(prompt: string, criteria: string): string {
  const stripped = prompt.replace(/^\/goal\s+/, '')
  return `/goal ${stripped}. Goal success criteria: ${criteria}`
}

function composeAutoLaunchPrompt(
  config: PendingLaunchConfig,
  sessionAgentSdk: string | null | undefined,
  configGoalMode: boolean,
  configGoalSuccessCriteria: string | null,
  options: { claudeCli: boolean }
): string | null {
  const trimmedPrompt = config.prompt.trim()
  if (!trimmedPrompt) return null

  const skipPrefix =
    options.claudeCli ||
    sessionAgentSdk === 'claude-code' ||
    sessionAgentSdk === 'codex' ||
    sessionAgentSdk === 'claude-code-cli'
  const modePrefix =
    config.mode === 'super-plan'
      ? getSuperPlanModePrefix(sessionAgentSdk)
      : config.mode === 'plan' && !skipPrefix
        ? PLAN_MODE_PREFIX
        : ''
  const fullPrompt = modePrefix + trimmedPrompt

  return configGoalMode && configGoalSuccessCriteria
    ? wrapGoalPrompt(fullPrompt, configGoalSuccessCriteria)
    : fullPrompt
}

export async function autoLaunchTicket(ticket: AutoLaunchTicket): Promise<void> {
  if (!ticket.pending_launch_config) return

  let config: PendingLaunchConfig
  try {
    config = JSON.parse(ticket.pending_launch_config) as PendingLaunchConfig
  } catch {
    console.error('Failed to parse pending_launch_config for ticket:', ticket.id)
    return
  }
  const configGoalMode = config.goalMode === true
  const configGoalSuccessCriteria = config.goalSuccessCriteria?.trim() || null
  const configAutoApprovePlan = config.autoApprovePlan === true
  // When inject is on for claude-code-cli we defer the spawn until setup resolves:
  // don't enqueue the raw prompt at createSession, hold the sidebar status, and run
  // the gated flow (await setup → scan → inject → enqueue → spawn) below.
  const willGate = config.sdk === 'claude-code-cli' && config.injectContext === true

  const project = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)
  if (!project) {
    console.error('Project not found for auto-launch:', ticket.project_id)
    return
  }

  void autoPinBaseWorktree(ticket.project_id)

  try {
    // 1. Resolve worktree
    let worktreeId: string
    if (config.worktree.type === 'new') {
      const nameHint = canonicalizeTicketTitle(ticket.title)
      const result = await useWorktreeStore
        .getState()
        .createWorktreeFromBranch(
          ticket.project_id,
          project.path,
          project.name,
          config.worktree.sourceBranch,
          nameHint || undefined
        )
      if (!result.success || !result.worktree?.id) {
        toast.error(`Auto-launch failed: ${result.error || 'Could not create worktree'}`)
        return
      }
      worktreeId = result.worktree.id
    } else {
      worktreeId = config.worktree.worktreeId

      // Reusing an existing worktree: branch off the chosen base onto a fresh
      // ticket-named branch before the session starts.
      if (config.reuseBranchBase) {
        const reusedWorktree = Array.from(
          useWorktreeStore.getState().worktreesByProject.values()
        )
          .flat()
          .find((w) => w.id === worktreeId)
        if (reusedWorktree?.path) {
          const branchResult = await worktreeApi.branchFromBase({
            worktreeId,
            worktreePath: reusedWorktree.path,
            ticketTitle: ticket.title,
            baseBranch: config.reuseBranchBase
          })
          if (!branchResult.success) {
            toast.error(
              `Auto-launch failed: ${branchResult.error || 'Could not create the new branch'}`
            )
            return
          }
          if (branchResult.branch) {
            useWorktreeStore.getState().updateWorktreeBranch(worktreeId, branchResult.branch)
          }
        }
      }
    }

    // 2. Create session
    const modelOverride = config.model ? { ...config.model, agentSdk: config.sdk } : undefined
    const cliPendingPrompt =
      config.sdk === 'claude-code-cli'
        ? composeAutoLaunchPrompt(config, config.sdk, configGoalMode, configGoalSuccessCriteria, {
            claudeCli: true
          })
        : null
    const createOptions = {
      autoFocus: false,
      ...(modelOverride ? { modelOverride } : {}),
      // This flow binds `ticket` to the new session itself (step 5 below). Skip the
      // kanban auto-attach so the new session can't ALSO be grabbed as some OTHER
      // orphan ticket's current_session_id — e.g. a sibling sharing this worktree
      // (speckit reuses one worktree per spec), which cross-wires two tickets to one
      // session and makes the ticket detail open the wrong terminal.
      skipKanbanAutoAttach: true,
      // When gating on setup, do NOT enqueue the raw prompt — the injected prompt
      // is enqueued only after setup resolves (leak-proof, single-queue ownership).
      ...(cliPendingPrompt && !willGate ? { pendingMessage: cliPendingPrompt } : {})
    }
    const sessionResult = await useSessionStore
      .getState()
      .createSession(worktreeId, ticket.project_id, config.sdk, config.mode, createOptions)
    if (!sessionResult.success || !sessionResult.session) {
      toast.error(`Auto-launch failed: ${sessionResult.error || 'Could not create session'}`)
      return
    }

    const sessionId = sessionResult.session.id
    const sessionAgentSdk = sessionResult.session.agent_sdk

    // Seed the in-memory per-session auto-approve override so the runtime effect
    // and live header toggle reflect the launch choice immediately.
    useSessionStore.getState().setAutoApprovePlan(sessionId, configAutoApprovePlan)

    // 3. Set status tracking
    messageSendTimes.set(sessionId, Date.now())
    userExplicitSendTimes.set(sessionId, Date.now())
    snapshotTokenBaseline(sessionId)
    lastSendMode.set(sessionId, isPlanLike(config.mode) ? 'plan' : 'build')
    // Defer the "working"/"planning" status while gating so the sidebar doesn't
    // imply the agent is running during the setup wait; set it once setup resolves.
    if (!willGate) {
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(config.mode) ? 'planning' : 'working')
    }

    // 4. Apply model override
    const effectiveModel = config.model ?? undefined
    if (config.model) {
      await useSessionStore.getState().setSessionModel(sessionId, config.model)
    }

    // 5. Update ticket: clear pending config, set session + worktree
    await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
      pending_launch_config: null,
      current_session_id: sessionId,
      worktree_id: worktreeId,
      mode: config.mode,
      goal_mode: configGoalMode,
      goal_success_criteria: configGoalMode ? configGoalSuccessCriteria : null,
      auto_approve_plan: configAutoApprovePlan
    })

    // 6. Trigger usage refresh
    useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(config.sdk))

    // 7. Toast notification
    toast.success(`Auto-launched: ${ticket.title}`)

    if (sessionAgentSdk === 'claude-code-cli') {
      if (config.mode === 'super-plan') {
        // Await so the persisted mode is committed before the main process
        // reads it in buildClaudeCliPtySpawn (createClaudeCli). Stays BEFORE the gate.
        await useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      // inject ON → nothing was enqueued at createSession: set the gate, wait for
      // setup, compose the injected prompt, enqueue it, then spawn (the mount path's
      // promptless create is the harmless loser via single-queue ownership). On
      // setup failure the gate goes `blocked` and the session view offers "Launch
      // anyway". Chain members share the head's already-set-up worktree, so
      // awaitWorktreeSetup resolves instantly for them.
      if (willGate) {
        useSessionStore.getState().setLaunchGate(sessionId, { state: 'awaiting', worktreeId })
        const gateWorktrees = Array.from(
          useWorktreeStore.getState().worktreesByProject.values()
        ).flat()
        const worktreeRow = gateWorktrees.find((w) => w.id === worktreeId)
        const scanTarget: WorktreeContextScanTarget | null = worktreeRow?.path
          ? {
              id: worktreeId,
              path: worktreeRow.path,
              branch_name: worktreeRow.branch_name,
              base_branch:
                config.worktree.type === 'new' ? config.worktree.sourceBranch : undefined
            }
          : null
        const prepared = await prepareWorktreeContextLaunch({
          worktreeId,
          scanTarget,
          basePrompt: cliPendingPrompt ?? '',
          template: config.contextTemplate || DEFAULT_CONTEXT_TEMPLATE
        })
        if (prepared.status === 'blocked') {
          // Block: surface the failure + "Launch anyway". Nothing is enqueued, so
          // there is nothing to requeue — the queue stays empty until the user acts.
          useSessionStore.getState().setLaunchGate(sessionId, {
            state: 'blocked',
            worktreeId,
            error: prepared.error,
            launchAnywayPrompt: prepared.prompt
          })
          return
        }
        useSessionStore.getState().setPendingMessage(sessionId, prepared.prompt)
        useSessionStore.getState().setLaunchGate(sessionId, { state: 'ready', worktreeId })
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, isPlanLike(config.mode) ? 'planning' : 'working')
      }

      // Atomically claim the queued prompt before spawning. The session view's
      // own mount path (ClaudeCliSessionView.createClaudeTerminal) races to send
      // the same prompt; both read this single queue, so whichever dequeues first
      // owns delivery and the other issues a promptless create. Passing a private
      // copy here (instead of consuming the queue) delivers the prompt twice —
      // once as a spawn arg and once as a paste injection on the already-live PTY.
      const outboundPrompt = useSessionStore.getState().dequeuePendingMessage(sessionId)

      bumpWorktreeLastMessage({ worktreeId })
      try {
        const result = unwrapEnvelope(
          await terminalApi.createClaudeCli(sessionId, {
            pendingPrompt: outboundPrompt
          })
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
        if (willGate) {
          useSessionStore.getState().clearLaunchGate(sessionId)
        }
      }
      return
    }

    // 8. Connect to OpenCode and send prompt
    const allWorktrees = Array.from(useWorktreeStore.getState().worktreesByProject.values()).flat()
    const worktree = allWorktrees.find((w) => w.id === worktreeId)
    if (!worktree?.path) return

    const connectResult = unwrapEnvelope(await opencodeApi.connect(worktree.path, sessionId))
    if (!connectResult.success || !connectResult.sessionId) {
      toast.error(`Auto-launch failed: ${connectResult.error || 'Could not start session'}`)
      return
    }

    useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
    await dbApi.session.update(sessionId, { opencode_session_id: connectResult.sessionId })

    // 9. Send prompt
    if (config.prompt.trim()) {
      const outboundPrompt = composeAutoLaunchPrompt(
        config,
        sessionAgentSdk,
        configGoalMode,
        configGoalSuccessCriteria,
        { claudeCli: false }
      )
      if (!outboundPrompt) return

      const promptOptions =
        sessionAgentSdk === 'codex' ? { codexFastMode: config.codexFastMode } : undefined

      if (config.mode === 'super-plan') {
        useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      bumpWorktreeLastMessage({ worktreeId })
      startHivePromptTelemetry({
        sessionId,
        prompt: outboundPrompt,
        worktreeId,
        modelId: effectiveModel?.modelID,
        providerId: effectiveModel?.providerID,
        modelVariant: effectiveModel?.variant,
        mode: config.mode
      })
      unwrapEnvelope(
        await opencodeApi.prompt(
          worktree.path,
          connectResult.sessionId,
          [{ type: 'text', text: outboundPrompt }],
          // Strip `agentSdk` — the prompt RPC model schema is .strict() and
          // rejects it ("RPC parameters failed validation").
          effectiveModel
            ? {
                providerID: effectiveModel.providerID,
                modelID: effectiveModel.modelID,
                variant: effectiveModel.variant
              }
            : undefined,
          promptOptions
        )
      )
    }
  } catch (err) {
    console.error('Auto-launch failed for ticket:', ticket.id, err)
    const detail = err instanceof Error ? err.message : null
    toast.error(`Auto-launch failed for: ${ticket.title}${detail ? ` — ${detail}` : ''}`)
  }
}
