import { telegramApi } from '@/api/telegram-api'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * Kanban ticket lifecycle events that fan out to Telegram. Each maps 1:1 to a
 * per-event toggle in Settings → Telegram (gated by the master toggle), and is
 * delivered to the same preconfigured bot + chat used by Telegram forwarding.
 */
export type TicketNotifyEvent = 'started' | 'question' | 'stuck_review' | 'done'

type TicketNotifySettingKey =
  | 'kanbanTelegramNotifyOnStart'
  | 'kanbanTelegramNotifyOnQuestion'
  | 'kanbanTelegramNotifyOnStuckReview'
  | 'kanbanTelegramNotifyOnDone'

const SETTING_BY_EVENT: Record<TicketNotifyEvent, TicketNotifySettingKey> = {
  started: 'kanbanTelegramNotifyOnStart',
  question: 'kanbanTelegramNotifyOnQuestion',
  stuck_review: 'kanbanTelegramNotifyOnStuckReview',
  done: 'kanbanTelegramNotifyOnDone'
}

/** The slice of settings this module reads (master + per-event toggles). */
interface NotifySettings {
  kanbanTelegramNotifyEnabled?: boolean
  kanbanTelegramNotifyOnStart?: boolean
  kanbanTelegramNotifyOnQuestion?: boolean
  kanbanTelegramNotifyOnStuckReview?: boolean
  kanbanTelegramNotifyOnDone?: boolean
}

const passesGate = (event: TicketNotifyEvent, settings: NotifySettings): boolean =>
  !!settings.kanbanTelegramNotifyEnabled && !!settings[SETTING_BY_EVENT[event]]

const buildText = (event: TicketNotifyEvent, title: string): string => {
  const name = title.trim() || 'Untitled ticket'
  switch (event) {
    case 'started':
      return `🚀 Started: "${name}" moved to In Progress`
    case 'question':
      return `❓ Question: "${name}" is waiting for your input`
    case 'stuck_review':
      return `⚠️ Needs you: "${name}" — Strict Verify exhausted its retries and couldn't finish. Needs your action.`
    case 'done':
      return `✅ Done: "${name}" completed`
  }
}

// Bounded LRU of dedupe keys that have been delivered. Bounded so a long-lived
// session that touches thousands of tickets can't grow this without limit. Oldest
// keys evict first; column-transition keys are also cleared eagerly when a ticket
// leaves the relevant state (see notifyTicketColumnChange).
const DEDUPE_LIMIT = 500
const delivered = new Map<string, true>()

function markDelivered(key: string): void {
  delivered.delete(key) // re-insert so it counts as most-recently-used
  delivered.set(key, true)
  if (delivered.size > DEDUPE_LIMIT) {
    const oldest = delivered.keys().next().value
    if (oldest !== undefined) delivered.delete(oldest)
  }
}

function clearDelivered(key: string): void {
  delivered.delete(key)
}

// In-flight sends keyed by dedupe key. Concurrent callers for the same key coalesce
// onto one network send instead of racing — without this, a second caller could
// early-return on the dedupe guard while the first send is still pending, then the
// first send fails and frees the slot, and neither delivers a message.
const inFlight = new Map<string, Promise<boolean>>()

interface NotifyTicketEventOpts {
  ticketId: string
  title: string
  /** Overrides the default `${event}:${ticketId}` dedupe key. */
  dedupeKey?: string
}

/**
 * Send a Telegram notification for a ticket lifecycle event. No-ops silently when
 * the master toggle or the event's toggle is off, when already delivered for this
 * dedupe key, or (server-side) when no Telegram bot is configured. Never throws.
 *
 * `settings` may be passed by callers that already read the store (e.g. the question
 * path) to avoid a second read; otherwise the current settings are used.
 */
export async function notifyTicketEvent(
  event: TicketNotifyEvent,
  opts: NotifyTicketEventOpts,
  settings?: NotifySettings
): Promise<void> {
  const resolved = settings ?? useSettingsStore.getState()
  if (!passesGate(event, resolved)) return

  const key = opts.dedupeKey ?? `${event}:${opts.ticketId}`
  if (delivered.has(key)) return

  // Coalesce onto an in-flight send for the same key; only proceed to send if the
  // pending one ultimately failed (and so left the slot open).
  const pending = inFlight.get(key)
  if (pending) {
    const ok = await pending.catch(() => false)
    if (ok || delivered.has(key)) return
  }

  const send = (async () => {
    const result = await telegramApi.sendNotification(buildText(event, opts.title))
    // Only a successful delivery burns the dedupe slot. "Not configured" / transient
    // failures leave it open so the event can fire once Telegram is set up.
    if (result.ok) {
      markDelivered(key)
      return true
    }
    return false
  })()
  inFlight.set(key, send)
  try {
    await send
  } catch (error) {
    console.warn('[TicketTelegramNotify] failed to send notification', error)
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Resolve the (active, non-terminal) ticket owning `sessionId` and notify that it
 * reached a "question" state (the agent asked the user something). `requestId` keys
 * the dedupe so each distinct question notifies at most once. Tickets already in Done
 * or archived are skipped, so a question.asked replayed on app relaunch for a closed
 * ticket does not raise a spurious alert.
 */
export async function notifyTicketQuestion(sessionId: string, requestId: string): Promise<void> {
  const settings = useSettingsStore.getState()
  if (!passesGate('question', settings)) return

  const { useKanbanStore } = await import('@/stores/useKanbanStore')
  for (const tickets of useKanbanStore.getState().tickets.values()) {
    const ticket = tickets.find(
      (t) => t.current_session_id === sessionId && t.column !== 'done' && !t.archived_at
    )
    if (ticket) {
      await notifyTicketEvent(
        'question',
        {
          ticketId: ticket.id,
          title: ticket.title,
          dedupeKey: `question:${ticket.id}:${requestId}`
        },
        settings
      )
      return
    }
  }
}

/**
 * Column-transition entry point used by the kanban store — by `moveTicket` (drags,
 * rescue re-promotes) AND by the in-place `updateTicket` writes that auto-launch and
 * auto-attach use to move a ticket Todo → In Progress. Fires "started" on the first
 * Todo → In Progress and "done" on a genuine transition into Done, and clears the
 * stale dedupe key when a ticket LEAVES those states so a reopen → re-complete can
 * legitimately notify again. No-op when `column` is unset or unchanged.
 */
export function notifyTicketColumnChange(args: {
  ticketId: string
  title: string
  prevColumn?: string
  column?: string
}): void {
  const { ticketId, title, prevColumn, column } = args
  if (!column || column === prevColumn) return

  // Leaving a previously-notified state re-opens its dedupe slot.
  if (prevColumn === 'in_progress' && column !== 'in_progress') clearDelivered(`started:${ticketId}`)
  if (prevColumn === 'done' && column !== 'done') clearDelivered(`done:${ticketId}`)

  if (prevColumn === 'todo' && column === 'in_progress') {
    void notifyTicketEvent('started', { ticketId, title }).catch(() => {})
  }
  // Genuine transition INTO Done only: require a known prior column so a move whose
  // pre-move snapshot is missing (undefined prevColumn) can't fire a false "Done".
  if (column === 'done' && prevColumn !== undefined && prevColumn !== 'done') {
    void notifyTicketEvent('done', { ticketId, title }).catch(() => {})
  }
}

/** Test-only: clear module-level dedupe state so tests don't leak into each other. */
export function resetTicketNotifyStateForTests(): void {
  delivered.clear()
  inFlight.clear()
}
