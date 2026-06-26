import { dbApi } from '@/api/db-api'
import { opencodeApi } from '@/api/opencode-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  useBoardChatStore,
  resolveBoardChatAgentSdk,
  resolveBoardChatDefaultModel
} from '@/stores/useBoardChatStore'
import type { Worktree } from '@shared/types/worktree'

export interface BoardAssistantRuntime {
  sessionId: string
  opencodeSessionId: string
  runtimePath: string
}

/**
 * Resolve the worktree path a project board assistant should run in: prefer the
 * currently selected worktree, then the project default, then any active one.
 */
export async function resolveProjectRuntime(
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

/**
 * Ensure a board-assistant chat (identified by its hive `sessionId`) has a live
 * OpenCode runtime, returning the runtime IDs to prompt against.
 *
 * The DB `sessions` row is created up-front by `createBoardAssistantSession`, so
 * this never creates a row — it only resolves a runtime path, connects OpenCode,
 * persists the resulting `opencode_session_id`, and mirrors the IDs into both the
 * board-chat snapshot and the session store. If the snapshot already carries
 * runtime IDs it reconnects and reuses them.
 */
export async function ensureBoardAssistantRuntime(
  sessionId: string
): Promise<BoardAssistantRuntime | null> {
  const boardStore = useBoardChatStore.getState()
  const snapshot = boardStore.getSessionSnapshot(sessionId)
  if (!snapshot) return null

  // Already connected — reconnect (best effort) and reuse the existing runtime.
  if (snapshot.opencodeSessionId && snapshot.runtimePath) {
    try {
      unwrapEnvelope(
        await opencodeApi.reconnect(snapshot.runtimePath, snapshot.opencodeSessionId, sessionId)
      )
    } catch {
      // useSessionStream will handle reconnection failures.
    }
    return {
      sessionId,
      opencodeSessionId: snapshot.opencodeSessionId,
      runtimePath: snapshot.runtimePath
    }
  }

  const scope = snapshot.scope
  if (!scope || scope.kind === 'pinned') return null

  const settings = useSettingsStore.getState()
  const baseAgentSdk =
    snapshot.selectedAgentSdkOverride ?? resolveBoardChatAgentSdk(settings.defaultAgentSdk)
  const selectedModel =
    snapshot.selectedModelOverride ?? resolveBoardChatDefaultModel(settings, baseAgentSdk)
  const agentSdk = snapshot.selectedAgentSdkOverride ?? selectedModel?.agentSdk ?? baseAgentSdk

  let runtimePath: string | null = null
  if (scope.kind === 'project') {
    const runtime = await resolveProjectRuntime(scope.projectId)
    if (!runtime) return null
    runtimePath = runtime.path
  } else if (scope.kind === 'connection') {
    const connection = useConnectionStore
      .getState()
      .connections.find((candidate) => candidate.id === scope.connectionId)
    if (!connection?.path) return null
    runtimePath = connection.path
  } else {
    return null
  }

  // Update the existing DB row (created up-front by createBoardAssistantSession)
  // with the current model/SDK selection. Never create a row here.
  await dbApi.session.update(sessionId, {
    agent_sdk: agentSdk,
    ...(selectedModel
      ? {
          model_provider_id: selectedModel.providerID,
          model_id: selectedModel.modelID,
          model_variant: selectedModel.variant ?? null
        }
      : {})
  })

  const connectResult = unwrapEnvelope(await opencodeApi.connect(runtimePath, sessionId))
  if (!connectResult.success || !connectResult.sessionId) {
    return null
  }

  await dbApi.session.update(sessionId, {
    opencode_session_id: connectResult.sessionId
  })

  boardStore.setRuntimeSessionForSession(sessionId, {
    opencodeSessionId: connectResult.sessionId,
    runtimePath,
    scope
  })
  useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)

  return {
    sessionId,
    opencodeSessionId: connectResult.sessionId,
    runtimePath
  }
}
