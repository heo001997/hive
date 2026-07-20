import { useState } from 'react'
import { CheckCircle2, ListTodo, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import {
  createTicketsFromDrafts,
  type CreatableTicketDraft
} from '@/lib/create-tickets-from-drafts'
import type { WarRoom, WarRoomOutcome } from '../../../../main/db/types'

interface Props {
  room: WarRoom
}

export function OutcomePanel({ room }: Props): React.JSX.Element | null {
  const outcome: WarRoomOutcome | null = room.outcome
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)

  if (!outcome) return null

  const actionItems = outcome.actionItems ?? []
  const openQuestions = outcome.openQuestions ?? []
  const canCreateTickets = Boolean(room.project_id) && actionItems.length > 0 && !created

  const handleCreateTickets = async (): Promise<void> => {
    if (!room.project_id) return
    setCreating(true)
    try {
      const drafts: CreatableTicketDraft[] = actionItems.map((item, i) => ({
        id: crypto.randomUUID(),
        draftKey: `war-${room.id.slice(0, 8)}-${i}`,
        title: item.length > 120 ? `${item.slice(0, 117)}…` : item,
        description: `From War Room "${room.title}".\n\nDecision: ${outcome.decision}\n\nAction item: ${item}`,
        projectId: room.project_id as string,
        dependsOn: []
      }))
      const result = await createTicketsFromDrafts(drafts, { mode: 'build' })
      if (result.failures.length > 0) {
        toast.error(`Created ${result.ticketCount}, ${result.failures.length} failed`)
      } else {
        toast.success(`Created ${result.ticketCount} ticket${result.ticketCount === 1 ? '' : 's'}`)
      }
      setCreated(true)
    } catch (err) {
      toast.error(`Failed to create tickets: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="rounded-lg border border-green-600/40 bg-green-500/5 p-4">
      <div className="mb-2 flex items-center gap-2 text-green-500">
        <CheckCircle2 className="h-4 w-4" />
        <h3 className="text-sm font-semibold">Agreement</h3>
      </div>

      <p className="text-sm font-medium text-foreground">{outcome.decision}</p>
      {outcome.rationale ? (
        <p className="mt-1 text-sm text-muted-foreground">{outcome.rationale}</p>
      ) : null}

      {actionItems.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Action items
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {actionItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {openQuestions.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Open questions
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {canCreateTickets ? (
        <Button className="mt-4" size="sm" onClick={handleCreateTickets} disabled={creating}>
          {creating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ListTodo className="h-4 w-4" />
          )}
          Create {actionItems.length} ticket{actionItems.length === 1 ? '' : 's'}
        </Button>
      ) : null}
      {created ? (
        <p className="mt-3 text-xs text-green-500">✓ Tickets created on the board.</p>
      ) : null}
      {!room.project_id && actionItems.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          This is a standalone room — attach it to a project to create tickets.
        </p>
      ) : null}
    </div>
  )
}
