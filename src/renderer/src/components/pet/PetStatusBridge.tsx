import { useEffect, useRef } from 'react'
import type { PetStatusPayload, PetTicket } from '@shared/types/pet'
import { petApi } from '@/api/pet-api'
import { openTicketDetail } from '@/lib/navigate-to-ticket'
import type { StoredCompletionVerdict } from '@shared/types/completion'
import {
  aggregatePetStatus,
  computePetTickets,
  petVerdictKey,
  type PetTicketInput
} from '@/lib/pet-status-aggregator'
import {
  useConnectionStore,
  useKanbanStore,
  useProjectStore,
  useQuestionStore,
  useSettingsStore,
  useSessionStore,
  useWorktreeStatusStore,
  useWorktreeStore
} from '@/stores'
import { ticketKey } from '@/stores/useKanbanStore'

function samePets(a: PetTicket[] | undefined, b: PetTicket[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (
      left[i].ticketId !== right[i].ticketId ||
      left[i].state !== right[i].state ||
      left[i].projectId !== right[i].projectId ||
      left[i].worktreeId !== right[i].worktreeId
    ) {
      return false
    }
  }
  return true
}

function sameStatus(a: PetStatusPayload | null, b: PetStatusPayload): boolean {
  return (
    a?.state === b.state &&
    a.sourceWorktreeId === b.sourceWorktreeId &&
    a.workingSessionCount === b.workingSessionCount &&
    samePets(a.pets, b.pets)
  )
}

function computePets(): PetTicket[] {
  const statusState = useWorktreeStatusStore.getState()
  const questionState = useQuestionStore.getState()

  const kanbanState = useKanbanStore.getState()
  const tickets: PetTicketInput[] = []
  for (const list of kanbanState.tickets.values()) {
    for (const ticket of list) tickets.push(ticket)
  }

  const pendingQuestionCountBySession = new Map<string, number>()
  for (const [sessionId, questions] of questionState.pendingBySession.entries()) {
    pendingQuestionCountBySession.set(sessionId, questions.length)
  }

  // Re-key the store's Strict Verify verdicts (encoded ticketKey) onto the
  // aggregator's pet-local key so the Review / needs-input gates can read them.
  const completionVerdicts = new Map<string, StoredCompletionVerdict>()
  for (const ticket of tickets) {
    const verdict = kanbanState.completionVerdicts.get(ticketKey(ticket.project_id, ticket.id))
    if (verdict) completionVerdicts.set(petVerdictKey(ticket.project_id, ticket.id), verdict)
  }

  return computePetTickets({
    tickets,
    sessionStatuses: statusState.sessionStatuses,
    pendingQuestionCountBySession,
    completionVerdicts
  })
}

function computeStatus(): PetStatusPayload {
  const statusState = useWorktreeStatusStore.getState()
  const sessionState = useSessionStore.getState()
  const connectionState = useConnectionStore.getState()

  const base = aggregatePetStatus({
    sessionStatuses: statusState.sessionStatuses,
    worktreeSessions: sessionState.sessionsByWorktree,
    connectionSessions: sessionState.sessionsByConnection,
    connections: connectionState.connections
  })

  return { ...base, pets: computePets() }
}

function jumpToWorktree(worktreeId: string): void {
  const worktreeState = useWorktreeStore.getState()
  const projectEntry = Array.from(worktreeState.worktreesByProject.entries()).find(
    ([, worktrees]) => worktrees.some((worktree) => worktree.id === worktreeId)
  )
  const projectId = projectEntry?.[0]

  if (projectId) {
    useProjectStore.getState().selectProject(projectId)
  }
  worktreeState.selectWorktree(worktreeId)
  useSessionStore.getState().setActiveWorktree(worktreeId)
}

export function PetStatusBridge(): null {
  const lastPublishedRef = useRef<PetStatusPayload | null>(null)

  useEffect(() => {
    const publishIfChanged = (): void => {
      const next = computeStatus()
      if (sameStatus(lastPublishedRef.current, next)) return
      lastPublishedRef.current = next
      petApi.publishStatus(next)
    }

    publishIfChanged()

    const cleanupStatus = useWorktreeStatusStore.subscribe(publishIfChanged)
    const cleanupSessions = useSessionStore.subscribe(publishIfChanged)
    const cleanupConnections = useConnectionStore.subscribe(publishIfChanged)
    const cleanupKanban = useKanbanStore.subscribe(publishIfChanged)
    const cleanupQuestions = useQuestionStore.subscribe(publishIfChanged)
    const cleanupJump = petApi.onJumpToWorktree(({ worktreeId }) => {
      if (worktreeId) jumpToWorktree(worktreeId)
    })
    const cleanupOpenTicket = petApi.onOpenTicket(({ projectId, ticketId }) => {
      void openTicketDetail(projectId, ticketId)
    })
    const cleanupSettings = petApi.onSettingsUpdated((settings) => {
      const current = useSettingsStore.getState().pet
      if (current.hasHatched !== settings.hasHatched) {
        useSettingsStore.setState({ pet: { ...current, hasHatched: settings.hasHatched } })
      }
    })

    return () => {
      cleanupStatus()
      cleanupSessions()
      cleanupConnections()
      cleanupKanban()
      cleanupQuestions()
      cleanupJump()
      cleanupOpenTicket()
      cleanupSettings()
    }
  }, [])

  return null
}
