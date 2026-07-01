import { telegramApi } from '@/api/telegram-api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTelegramStore } from '@/stores/useTelegramStore'

/**
 * Kanban ticket lifecycle events that fan out to Telegram. Each maps 1:1 to a
 * per-event toggle in Settings → Telegram (gated by the master toggle), and is
 * delivered to the same preconfigured bot + chat used by Telegram forwarding.
 */
export type TicketNotifyEvent = 'started' | 'question' | 'review' | 'stuck_review' | 'done'

type TicketNotifySettingKey =
  | 'kanbanTelegramNotifyOnStart'
  | 'kanbanTelegramNotifyOnQuestion'
  | 'kanbanTelegramNotifyOnReview'
  | 'kanbanTelegramNotifyOnStuckReview'
  | 'kanbanTelegramNotifyOnDone'

const SETTING_BY_EVENT: Record<TicketNotifyEvent, TicketNotifySettingKey> = {
  started: 'kanbanTelegramNotifyOnStart',
  question: 'kanbanTelegramNotifyOnQuestion',
  review: 'kanbanTelegramNotifyOnReview',
  stuck_review: 'kanbanTelegramNotifyOnStuckReview',
  done: 'kanbanTelegramNotifyOnDone'
}

/** The slice of settings this module reads (master + per-event toggles). */
interface NotifySettings {
  kanbanTelegramNotifyEnabled?: boolean
  kanbanTelegramNotifyOnStart?: boolean
  kanbanTelegramNotifyOnQuestion?: boolean
  kanbanTelegramNotifyOnReview?: boolean
  kanbanTelegramNotifyOnStuckReview?: boolean
  kanbanTelegramNotifyOnDone?: boolean
  kanbanTelegramAutoForwardOnUserAction?: boolean
}

const passesGate = (event: TicketNotifyEvent, settings: NotifySettings): boolean =>
  !!settings.kanbanTelegramNotifyEnabled && !!settings[SETTING_BY_EVENT[event]]

const passesAutoForwardGate = (settings: NotifySettings): boolean =>
  !!settings.kanbanTelegramNotifyEnabled && !!settings.kanbanTelegramAutoForwardOnUserAction

const buildText = (event: TicketNotifyEvent, title: string): string => {
  const name = title.trim() || 'Untitled ticket'
  switch (event) {
    case 'started':
      return `🚀 Started: "${name}" moved to In Progress`
    case 'question':
      return `❓ Question: "${name}" is waiting for your input`
    case 'review':
      return `🔍 Review: "${name}" reached Review — ready for your review`
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
 * The shared "ticket is waiting on the user" fan-out: the Telegram `question` ping
 * plus (when enabled) auto-forwarding the session so the user can answer from
 * Telegram. Both question triggers funnel through here so they behave identically —
 * the structured `question.asked` tool-hold ([[notifyTicketQuestion]]) and the
 * transcript-verdict `needsInput` signal ([[notifyTicketNeedsInput]]). `dedupeKey`
 * distinguishes each distinct question. Never throws.
 */
async function deliverQuestionNotify(
  args: {
    ticketId: string
    title: string
    sessionId: string
    worktreeId: string | null
    dedupeKey: string
  },
  settings: NotifySettings,
  wantNotify: boolean,
  wantForward: boolean
): Promise<void> {
  if (wantNotify) {
    await notifyTicketEvent(
      'question',
      { ticketId: args.ticketId, title: args.title, dedupeKey: args.dedupeKey },
      settings
    )
  }
  if (wantForward) {
    await autoForwardTicketForUserAction(
      { sessionId: args.sessionId, worktreeId: args.worktreeId, connectionId: null },
      settings
    )
  }
}

/**
 * Resolve the (active, non-terminal) ticket owning `sessionId` and notify that it
 * reached a "question" state (the agent asked the user something). `requestId` keys
 * the dedupe so each distinct question notifies at most once. Tickets already in Done
 * or archived are skipped, so a question.asked replayed on app relaunch for a closed
 * ticket does not raise a spurious alert.
 *
 * This is the STRUCTURED-tool trigger: it fires only when the agent used the question
 * tool-hold (which emits `question.asked`). Flows that ask the user via plain
 * transcript text — e.g. speckit clarify-all's "answer Q1–Q4" prompt — never emit that
 * event; those surface through the Strict-Verify `needsInput` verdict instead and are
 * covered by [[notifyTicketNeedsInput]].
 */
export async function notifyTicketQuestion(sessionId: string, requestId: string): Promise<void> {
  const settings = useSettingsStore.getState()
  const wantNotify = passesGate('question', settings)
  const wantForward = passesAutoForwardGate(settings)
  // Both features resolve the same ticket; skip the kanban read entirely if neither is on.
  if (!wantNotify && !wantForward) return

  const { useKanbanStore } = await import('@/stores/useKanbanStore')
  for (const tickets of useKanbanStore.getState().tickets.values()) {
    const ticket = tickets.find(
      (t) => t.current_session_id === sessionId && t.column !== 'done' && !t.archived_at
    )
    if (ticket) {
      await deliverQuestionNotify(
        {
          ticketId: ticket.id,
          title: ticket.title,
          sessionId,
          worktreeId: ticket.worktree_id ?? null,
          dedupeKey: `question:${ticket.id}:${requestId}`
        },
        settings,
        wantNotify,
        wantForward
      )
      return
    }
  }
}

/**
 * Verdict-driven sibling of [[notifyTicketQuestion]]. Fires the same "question" ping
 * (+ auto-forward) when Strict Verify judges a ticket's transcript as `needsInput:true`
 * — i.e. the agent stopped to ask the user something as PLAIN TRANSCRIPT TEXT rather
 * than through the structured question tool-hold. That plain-text path never emits
 * `question.asked`, so without this hook the "Questions" badge lights up but no Telegram
 * alert is sent (the exact speckit clarify-all gap this closes). The caller already holds
 * the ticket, so no session→ticket resolution is needed. Deduped per (ticket, session):
 * one genuine waiting-on-user verdict pings once; a later user resume (new session) pings
 * again. Never throws.
 */
export async function notifyTicketNeedsInput(args: {
  ticketId: string
  title: string
  sessionId: string
  worktreeId?: string | null
}): Promise<void> {
  const settings = useSettingsStore.getState()
  const wantNotify = passesGate('question', settings)
  const wantForward = passesAutoForwardGate(settings)
  if (!wantNotify && !wantForward) return

  await deliverQuestionNotify(
    {
      ticketId: args.ticketId,
      title: args.title,
      sessionId: args.sessionId,
      worktreeId: args.worktreeId ?? null,
      dedupeKey: `question:${args.ticketId}:${args.sessionId}`
    },
    settings,
    wantNotify,
    wantForward
  )
}

/** Forwarding mode auto-forward starts in — full "all" mode so Telegram mirrors the
 * session like the real terminal (streams agent output + forwards question /
 * permission / plan option-buttons + accepts typed replies). */
const AUTO_FORWARD_MODE = 'all' as const

interface AutoForwardTarget {
  sessionId: string
  worktreeId: string | null
  connectionId: string | null
}

// Coalesce concurrent auto-forward attempts for the same session — the active-forward
// guard below only flips once startForwarding's status round-trips through the store,
// so two near-simultaneous needs-action events could otherwise both start.
const autoForwardInFlight = new Set<string>()

/**
 * Auto-start Telegram forwarding for a ticket's session when the ticket reaches a
 * "needs user action" state (Question or stuck Review), so the user can chat and tap
 * option-buttons from Telegram exactly like the session terminal. Starts in full "all"
 * mode. No-op (silent) when the master / auto-forward toggles are off, when there is no
 * usable forwarding target (needs exactly one of worktree / connection), or when ANY
 * forward is already active — auto-forward never steals an in-progress forward, and
 * forwarding the same session again would be redundant. Never throws.
 */
export async function autoForwardTicketForUserAction(
  target: AutoForwardTarget,
  settings?: NotifySettings
): Promise<void> {
  const resolved = settings ?? useSettingsStore.getState()
  if (!passesAutoForwardGate(resolved)) return

  const { sessionId, worktreeId, connectionId } = target
  // startForwarding requires exactly one target (worktree XOR connection).
  if (!sessionId || !!worktreeId === !!connectionId) return

  // Don't steal: if a manual (or earlier auto) forward is already active — whether for
  // this session or another — leave it. The notification already alerted the user.
  if (useTelegramStore.getState().activeForwardingSessionId) return
  if (autoForwardInFlight.has(sessionId)) return

  autoForwardInFlight.add(sessionId)
  try {
    const result = await telegramApi.startForwarding({
      sessionId,
      worktreeId,
      connectionId,
      mode: AUTO_FORWARD_MODE
    })
    if (result.ok) useTelegramStore.getState().setStatus(result.status)
  } catch (error) {
    console.warn('[TicketTelegramNotify] failed to auto-forward ticket session', error)
  } finally {
    autoForwardInFlight.delete(sessionId)
  }
}

/**
 * Column-transition entry point used by the kanban store — by `moveTicket` (drags,
 * rescue re-promotes) AND by the in-place `updateTicket` writes that auto-launch and
 * auto-attach use to move a ticket Todo → In Progress. Fires "started" on the first
 * Todo → In Progress, "review" on a genuine transition into Review (ready for your
 * review), and "done" on a genuine transition into Done, and clears the stale dedupe
 * key when a ticket LEAVES those states so a reopen → re-complete can legitimately
 * notify again. No-op when `column` is unset or unchanged.
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
  // The Review dedupe slot is NOT freed here when leaving Review — the review↔fix
  // iterate loop bounces a ticket Review → In Progress → Review repeatedly (Strict
  // Verify / lifecycle callbacks re-promote it, no user involved), and we want exactly
  // ONE "review" ping per automated cycle, not one per bounce. The slot is reset only
  // when the ticket lands back at a genuine cycle boundary (Todo) or finishes (Done) —
  // or when the USER resumes it (see clearReviewNotifyOnResume) — so a later, genuinely
  // new re-review notifies again.
  if (column === 'todo' || column === 'done') clearDelivered(`review:${ticketId}`)

  if (prevColumn === 'todo' && column === 'in_progress') {
    void notifyTicketEvent('started', { ticketId, title }).catch(() => {})
  }
  // Genuine transition INTO Review only: require a known prior column so a move whose
  // pre-move snapshot is missing (undefined prevColumn) can't fire a false "Review" on
  // app load for a ticket already sitting in Review.
  if (column === 'review' && prevColumn !== undefined && prevColumn !== 'review') {
    void notifyTicketEvent('review', { ticketId, title }).catch(() => {})
  }
  // Genuine transition INTO Done only: require a known prior column so a move whose
  // pre-move snapshot is missing (undefined prevColumn) can't fire a false "Done".
  if (column === 'done' && prevColumn !== undefined && prevColumn !== 'done') {
    void notifyTicketEvent('done', { ticketId, title }).catch(() => {})
  }
}

/**
 * Free the "review" dedupe slot for a ticket on a GENUINE user resume out of Review —
 * the user typed into the session again (directly in the CLI terminal, or via the
 * ticket followup input) and sent the ticket back to In Progress for fresh work. That
 * closes the current review cycle, so the NEXT time the ticket genuinely reaches Review
 * it is a new "ready for your review" event and notifies again.
 *
 * This is deliberately NOT done in notifyTicketColumnChange's leave-Review branch: the
 * review↔fix iterate loop's internal Review → In Progress → Review bounces (driven by
 * Strict Verify / lifecycle callbacks, no user involved) must still ping exactly once
 * per automated cycle. Only a real user resume — the caller's responsibility to detect —
 * reopens the slot.
 */
export function clearReviewNotifyOnResume(ticketId: string): void {
  clearDelivered(`review:${ticketId}`)
}

/** Test-only: clear module-level dedupe state so tests don't leak into each other. */
export function resetTicketNotifyStateForTests(): void {
  delivered.clear()
  inFlight.clear()
  autoForwardInFlight.clear()
}
