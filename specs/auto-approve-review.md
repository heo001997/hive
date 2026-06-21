# Spec — Chain-aware Auto-approve Review

## Goal

Reduce manual babysitting of build tickets sitting in the **Review** column, while
keeping a human gate exactly where it matters (PR & merge). Works for both:

- **Small ticket** — one ticket = one fix. Stays in Review for the human to PR & merge.
- **Big ticket** — one source item split into N chained Speckit tickets (ticket _k_
  depends on ticket _k-1_). The chain advances itself; only the **last** ticket
  waits for the human.

## Model — per-ticket opt-in, global seed

Auto-approve is a **per-ticket** flag. Each ticket carries its own
`auto_approve_review` boolean; the **engine reads only that flag**, never the global
setting. The global "Auto-approve Review by default" setting is **seed-only**: it
sets the initial value of the checkbox when a **new** ticket is created. Flipping the
global later does **not** touch existing tickets.

The per-ticket flag is just an on/off switch. The **delay** and **auto-commit**
remain global behavior and apply to *any* ticket whose own checkbox is on.

### Per-ticket flag (`auto_approve_review`)

- DB column `kanban_tickets.auto_approve_review INTEGER NOT NULL DEFAULT 0`
  (migration v36). Existing tickets default **OFF**.
- Stored as INTEGER 0/1; mapped to `boolean` on `KanbanTicket`
  (pattern matches `plan_ready`, `goal_mode`, `created_from_session`).
- Editable in **Ticket Detail** (`KanbanTicketModal`) via an "Auto-approve Review"
  toggle (`role="switch"`, testid `ticket-edit-auto-approve-review-toggle`).
- Seeded at creation: `createTicket` fills the flag from the global default when the
  caller doesn't pass an explicit value.

## Settings (global, `useSettingsStore`)

Under **Settings → General → "Auto-approve Review"**:

| Setting | Key | Default | Meaning |
| --- | --- | --- | --- |
| Auto-approve Review by default | `kanbanAutoApproveReview` | `false` | **Seed-only** default for a new ticket's per-ticket checkbox. Does **not** gate the engine and does **not** affect existing tickets. |
| Auto commit on Review | `kanbanAutoCommitOnReview` | `false` | Global behavior — stage + commit the worktree of any opted-in ticket when it settles. |
| Auto approve after (s) | `kanbanAutoApproveDelaySeconds` | `10` | Global behavior — idle settle window (0–600) before the engine acts, for any opted-in ticket. |

## Behavior

When a **build** ticket with `auto_approve_review` on enters **Review**, schedule an
auto-approve after the settle delay. Leaving Review for any other column — or
toggling the flag off in place — cancels the pending approval. Toggling the flag on
while the ticket already sits in Review arms the timer.

At fire time, re-validate **all** safety guards (else abort silently, leaving the
ticket in Review):

1. The ticket's own `auto_approve_review` flag is still on.
2. Ticket is still a `build` ticket sitting in `review`.
3. Its session is genuinely idle (`completed`) and has been for the full settle
   window. The timer resets on any resume of work, absorbing the transient
   `completed → working → completed` churn from multi-turn agents, queued
   follow-ups, and app-relaunch status replays.
4. No queued follow-up messages for the session.

If the guards hold:

1. **Commit** the ticket's worktree (if `kanbanAutoCommitOnReview`). Each chain
   step becomes its own commit. Non-fatal: an empty/failed commit is logged, not
   thrown.
2. **Branch on terminality:**
   - **Non-terminal** (another ticket declares this one as a blocker) → move to
     **Done**. Moving to Done unblocks dependents and **auto-launches the next
     chain ticket** through the **existing** auto-launch path — i.e. using that
     ticket's own `pending_launch_config` (a `new` or `existing` worktree, exactly
     as configured when it was queued). The engine does **not** force a shared
     branch/worktree; the previous config is respected.
   - **Terminal** (last step of a chain, or a standalone ticket — nothing depends
     on it) → **stay in Review** for the human to PR & merge.

### Terminality

A ticket is **non-terminal** iff some other ticket's blocker set contains it
(`dependencyMap` reverse scan). Otherwise it is **terminal**.

## Flows

**Small ticket**
1. Todo → In Progress → agent works → lands in Review.
2. If its checkbox is on: engine auto-commits (if enabled). Terminal → stays in
   Review.
3. Human PRs, merges, moves to Done.

**Big ticket (N chained)**
1. Create N tickets in Todo, chained `1 → N`; each new ticket's checkbox is seeded
   from the global default (toggle per ticket as desired); configure each ticket's
   launch config (worktree `new`/`existing`).
2. Drag ticket 1 to In Progress → agent works → Review.
3. Ticket 1 settles → auto-commit → has a dependent → **Done** → ticket 2
   auto-launches via its own config.
4. Repeat for 2 … N-1.
5. Ticket N settles → auto-commit → terminal → **stays in Review**. Human PRs &
   merges.

## Implementation map

- `src/main/db/types.ts` — `auto_approve_review` on `KanbanTicket` (+ optional on
  `KanbanTicketCreate` / `KanbanTicketUpdate`).
- `src/main/db/schema.ts` — migration v36 `add_ticket_auto_approve_review`;
  `CURRENT_SCHEMA_VERSION = 36`.
- `src/main/db/database.ts` — create/update/map the column (INTEGER 0/1 ⇄ boolean).
- `src/server/rpc/domains/kanban.ts` — `auto_approve_review` added to the
  (`.strict()`) create + update zod schemas.
- `src/main/services/kanban-backend.ts` — markdown frontmatter read
  (`auto_approve_review`); clone-create carries the flag.
- `src/renderer/src/stores/useSettingsStore.ts` — the three settings; the master
  one documented as seed-only default.
- `src/renderer/src/stores/useKanbanStore.ts` — settle-timer engine
  (`scheduleAutoApprove` / `cancelAutoApprove` / `maybeAutoApprove`, now gated on
  the ticket's own flag), terminality (`ticketHasDependent`),
  `commitTicketWorktree`, `moveReviewedTicketToDone`. `createTicket` seeds the flag
  from the global default; `updateTicket` arms/cancels the timer when the flag is
  toggled in place. Scheduling is wired into `moveTicket` (the single funnel for all
  column moves); the move-to-Done path reuses the existing dependent auto-launch
  block.
- `src/renderer/src/components/kanban/KanbanTicketModal.tsx` — per-ticket toggle UI.
- `src/renderer/src/lib/auto-launch.ts` — unchanged dependent launch; reads each
  ticket's `pending_launch_config`.
- `src/renderer/src/components/settings/SettingsGeneral.tsx` — settings UI (master
  default + always-visible global delay/commit controls).

## Tests

- `useKanbanStore.auto-approve-review.test.ts` — acts only on a ticket whose own
  flag is on (ignores global); terminal stays in Review; non-terminal (seeded via
  `dependencyMap`) advances to Done; commit on/off; every safety guard;
  `createTicket` seeds the flag from the global default; `updateTicket` toggle
  arms/cancels the settle timer.
