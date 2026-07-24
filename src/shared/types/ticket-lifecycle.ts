/**
 * Per-ticket lifecycle-callback model. Every kanban state gets FOUR ordered hook
 * slots:
 *   - BEFORE  — stable entry (the ticket genuinely settled INTO this state)
 *   - RETRY   — loop re-entry (a verdict branch sent the ticket back here mid-loop)
 *   - DURING  — the agent is actively running while resident in this state
 *   - AFTER   — stable exit (the ticket genuinely settled OUT into the next state)
 * plus per-state `branches` (verdict → goto state) and a `retryMax` loop-breaker.
 *
 * The defining design decision is that BEFORE/AFTER fire on STABILITY — a confirmed
 * `lifecycle_state` edge — NOT on the optimistic board-column move. The board column
 * jumps optimistically (agent stops → column → Review); the settle handlers later
 * CONFIRM the ticket genuinely settled and only then fire the edge. RETRY is the
 * loop re-entry (the review↔fix bounce), distinct from the stable BEFORE.
 *
 * The first concrete instance is the review↔fix iterate loop:
 *   review.during  = [{ type: 'review' }]            — the Strict-Verify Reviewer
 *   review.branches = [{ when: 'fail', goto: 'in_progress' }]
 *   review.retryMax = N                              — cap the loop
 *   in_progress.retry = [{ type: 'prompt', config: { template } }]  — the fix prompt
 *
 * Stored per-ticket (DB column `lifecycle_callbacks`) and seeded from a global
 * default, exactly like `auto_approve_review`. The active-loop runtime state
 * (`lifecycle_state` + `lifecycle_iteration`) is persisted on the ticket row too,
 * so the loop survives app restarts.
 */

/**
 * Action kinds a lifecycle slot can hold. Each runs an existing engine primitive.
 * SINGLE SOURCE OF TRUTH — the type below is derived from this array and the
 * server zod validator (`kanban.ts`) + the editor dropdown both consume it, so a
 * new kind is added in exactly one place and can never drift (see `agent-sdk.ts`
 * for the same `z.enum(CONST)` convention). A missing entry here was why the
 * Condition Gate `evaluate` action failed the update-ticket RPC validator.
 */
export const LIFECYCLE_ACTION_TYPES = [
  'prompt',
  'agent',
  'check',
  'review',
  'evaluate',
  'notify',
  'goto',
  'wait'
] as const

/** Action kinds a lifecycle slot can hold. Derived from {@link LIFECYCLE_ACTION_TYPES}. */
export type LifecycleActionType = (typeof LIFECYCLE_ACTION_TYPES)[number]

/** The slots a state's actions can live in. */
export type LifecycleSlot = 'before' | 'retry' | 'during' | 'after'

/** The verdicts a DURING/AFTER gate can produce, used to pick a branch. */
export type LifecycleVerdict = 'pass' | 'fail' | 'needsInput'

/** Kanban states a ticket flows through. Structurally identical to `KanbanTicketColumn`.
 * `human_required` is a transient "blocked on the user" holding state (no lifecycle
 * hooks are configured for it) — included so a `column`→`LifecycleState` cast stays total. */
export type LifecycleState = 'todo' | 'in_progress' | 'human_required' | 'review' | 'done'

/** Entry context for a before/retry slot — distinguishes a first entry from a loop re-entry. */
export type LifecycleEntryContext = 'initial' | 'retry'

/**
 * One configured action. `config` is type-specific:
 *  - prompt → { template: string }   — supports {{reason}} {{title}} {{iteration}}
 *  - agent  → { prompt: string; mode?: string }
 *  - check  → { command: string }
 *  - review → {}                     — uses the global Strict-Verify settings
 *  - notify → { event: string; message?: string }
 *  - goto   → { state: LifecycleState }
 *  - wait   → { seconds: number }
 *  - evaluate → { provider?; model?; prompt?; maxRounds?; autoDone? }
 *               — marks a review ticket as a CONDITION GATE (Stage 2). After
 *               Stage-1 Strict-Verify passes, an LLM reads the review's return and
 *               routes pass/fix/needs-human (see `lib/ticket-lifecycle`
 *               `buildConditionGateConfig` / `useKanbanStore.runConditionGate`).
 *
 * `runOn` (before/retry only) filters by entry context: a value of `['retry']`
 * runs the action only on a loop re-entry, `['initial']` only on a first entry.
 * Undefined = both (the default).
 */
export interface LifecycleAction {
  id: string
  type: LifecycleActionType
  config: Record<string, unknown>
  runOn?: LifecycleEntryContext[]
}

/**
 * Back-compat aliases for the original names (the first cut called these "hooks").
 * Kept so older imports keep compiling; new code should use `LifecycleAction`.
 */
export type LifecycleHook = LifecycleAction
export type LifecycleHookType = LifecycleActionType

/** A verdict → goto edge. `goto: 'end'` stops the loop (no further transition). */
export interface LifecycleBranch {
  when: LifecycleVerdict
  goto: LifecycleState | 'end'
}

/** The four action slots + branches + loop-breaker for a single state. */
export interface LifecycleStateConfig {
  /** Actions run when the ticket STABLY ENTERS this state. */
  before?: LifecycleAction[]
  /** Actions run when a branch sends the ticket BACK here mid-loop (the loop re-entry). */
  retry?: LifecycleAction[]
  /** Resident monitors / the work itself while the ticket sits in this state. */
  during?: LifecycleAction[]
  /** Actions run as the ticket STABLY LEAVES this state. */
  after?: LifecycleAction[]
  /** verdict → goto edges. The fail branch drives the review↔fix bounce. */
  branches?: LifecycleBranch[]
  /** Maximum loop iterations through this state before giving up (the loop-breaker). */
  retryMax?: number
}

/** A ticket's full lifecycle-callback configuration. */
export interface TicketLifecycleConfig {
  enabled: boolean
  states: Partial<Record<LifecycleState, LifecycleStateConfig>>
}
