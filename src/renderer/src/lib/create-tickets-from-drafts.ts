/**
 * Shared "turn draft set into board tickets" path, extracted from
 * `useBoardChatStore.createSelected` so the condition-gate fix loop can reuse the
 * EXACT same batch-create flow (group-by-project → `kanban.ticket.createBatch` →
 * reload tickets + dependencies) WITHOUT going through the Board Assistant chat.
 *
 * Pure-ish: it talks to the kanban RPC + the kanban store, but holds no UI state.
 * Callers own messaging / draft-bookkeeping (the chat store marks drafts created;
 * the gate commits + advances the review ticket).
 */
import { kanbanApi } from '@/api/kanban-api'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { KanbanTicketBatchCreate, KanbanTicketBatchCreateResult } from '../../../main/db/types'
import type { TicketLifecycleConfig } from '@shared/types/ticket-lifecycle'

/**
 * The minimal draft shape this helper needs. Board-chat `TicketDraft` and the
 * parser's `ParsedBoardAssistantDraft` both satisfy it. `id` is whatever the
 * caller wants echoed back in `createdDraftIds` (the chat store passes its draft
 * id; the gate passes the draftKey).
 */
export interface CreatableTicketDraft {
  id: string
  draftKey: string
  title: string
  description: string | null
  projectId: string
  /** Display name for failure messages (defaults to the project id). */
  projectName?: string
  dependsOn: string[]
}

export interface CreateTicketsFromDraftsOptions {
  /**
   * Per-draft lifecycle config to seed onto the created ticket — return the
   * condition-gate config for the review draft, `null` for the rest. When it
   * returns non-null the ticket is also anchored at `lifecycle_state: 'todo'`
   * (mirrors `useKanbanStore.createTicket`).
   */
  seedLifecycle?: (draft: CreatableTicketDraft) => TicketLifecycleConfig | null
  /**
   * Force this session mode on every created ticket. Review-gate chains need
   * `'build'` so their gates can arm (`armSettleTimers`/`passesSettleGuards`
   * hard-require build mode).
   */
  mode?: 'build' | 'plan' | 'super-plan'
}

export interface CreateTicketsFromDraftsResult {
  ticketCount: number
  dependencyCount: number
  /** Echoed `draft.id`s for every draft in a successfully-created project batch. */
  createdDraftIds: string[]
  /** `"{projectName}: {error}"` per project batch that failed. */
  failures: string[]
}

/**
 * Create board tickets from `drafts`, batched per project (the RPC requires every
 * draft in a batch to share a project). Reloads tickets + dependencies for each
 * project that succeeded. Never throws — partial failures land in `failures` so
 * callers can decide how loudly to surface them.
 */
export async function createTicketsFromDrafts(
  drafts: CreatableTicketDraft[],
  options: CreateTicketsFromDraftsOptions = {}
): Promise<CreateTicketsFromDraftsResult> {
  const result: CreateTicketsFromDraftsResult = {
    ticketCount: 0,
    dependencyCount: 0,
    createdDraftIds: [],
    failures: []
  }
  if (drafts.length === 0) return result

  // Seed each draft's per-ticket auto-approve flag from the global default,
  // matching useKanbanStore.createTicket — batch creation bypasses that store
  // action, so without this the tickets would ignore the user's global setting.
  const autoApproveReviewDefault = useSettingsStore.getState().kanbanAutoApproveReview

  const draftsByProject = new Map<string, CreatableTicketDraft[]>()
  for (const draft of drafts) {
    draftsByProject.set(draft.projectId, [...(draftsByProject.get(draft.projectId) ?? []), draft])
  }

  const batches = [...draftsByProject.entries()].map(([projectId, projectDrafts]) => {
    const projectDraftKeys = new Set(projectDrafts.map((draft) => draft.draftKey))
    return {
      projectId,
      projectName: projectDrafts[0]?.projectName ?? projectId,
      projectDrafts,
      request: kanbanApi.ticket.createBatch<KanbanTicketBatchCreateResult, KanbanTicketBatchCreate>(
        projectId,
        {
          drafts: projectDrafts.map((draft) => {
            const lifecycle = options.seedLifecycle?.(draft) ?? null
            return {
              draft_key: draft.draftKey,
              project_id: draft.projectId,
              title: draft.title,
              description: draft.description ?? null,
              column: 'todo' as const,
              auto_approve_review: autoApproveReviewDefault,
              ...(options.mode ? { mode: options.mode } : {}),
              ...(lifecycle
                ? { lifecycle_callbacks: lifecycle, lifecycle_state: 'todo' as const }
                : {}),
              depends_on: draft.dependsOn.filter((key) => projectDraftKeys.has(key))
            }
          })
        }
      )
    }
  })

  const settled = await Promise.allSettled(batches.map((batch) => batch.request))
  const successfulProjectIds: string[] = []

  settled.forEach((settledResult, index) => {
    const batch = batches[index]
    if (settledResult.status === 'fulfilled') {
      result.ticketCount += settledResult.value.tickets.length
      result.dependencyCount += settledResult.value.dependencies.length
      result.createdDraftIds.push(...batch.projectDrafts.map((draft) => draft.id))
      successfulProjectIds.push(batch.projectId)
      return
    }
    const message =
      settledResult.reason instanceof Error
        ? settledResult.reason.message
        : String(settledResult.reason)
    result.failures.push(`${batch.projectName}: ${message}`)
  })

  for (const projectId of successfulProjectIds) {
    await useKanbanStore.getState().loadTickets(projectId)
    await useKanbanStore.getState().loadDependencies(projectId)
  }

  return result
}
