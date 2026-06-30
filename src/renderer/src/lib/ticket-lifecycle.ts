/**
 * Pure helpers for the per-ticket lifecycle-callback engine. No side effects — the
 * store (`useKanbanStore`) wires these into the existing Strict-Verify / rescue
 * seams via a single dispatcher. Fully unit-tested in
 * `__tests__/ticket-lifecycle.test.ts`.
 */
import type {
  LifecycleAction,
  LifecycleBranch,
  LifecycleEntryContext,
  LifecycleSlot,
  LifecycleState,
  LifecycleVerdict,
  TicketLifecycleConfig
} from '@shared/types/ticket-lifecycle'

export type { LifecycleSlot, LifecycleEntryContext } from '@shared/types/ticket-lifecycle'

/**
 * Default fix-prompt fed back to the agent when the Reviewer bounces a ticket.
 * `{{reason}}` is substituted with the Reviewer's one-line reason. Lives here so
 * the settings store seeds/resets to exactly this text.
 */
export const DEFAULT_FIX_PROMPT_TEMPLATE =
  'Review found the work incomplete:\n\n{{reason}}\n\nFix it, then stop.'

/** The canonical review↔fix loop config (the first concrete lifecycle instance). */
export function buildDefaultLoopConfig({
  maxIterations,
  fixPromptTemplate
}: {
  maxIterations: number
  fixPromptTemplate: string
}): TicketLifecycleConfig {
  const retryMax = Number.isFinite(maxIterations) ? Math.max(1, Math.floor(maxIterations)) : 3
  const template = fixPromptTemplate?.length ? fixPromptTemplate : DEFAULT_FIX_PROMPT_TEMPLATE
  return {
    enabled: true,
    states: {
      // DURING(review): the Strict-Verify Reviewer judges the work.
      // branches: a fail bounces back to In Progress; PASS has NO branch
      // (auto-approve / the human owns pass — the loop only owns fail).
      review: {
        during: [{ id: 'review-during', type: 'review', config: {} }],
        branches: [{ when: 'fail', goto: 'in_progress' }],
        retryMax
      },
      // RETRY(in_progress): re-arm the agent with the fix prompt on a loop bounce.
      // RETRY (not BEFORE) so a plain/first entry into In Progress never re-prompts.
      in_progress: {
        retry: [
          { id: 'in-progress-retry-prompt', type: 'prompt', config: { template }, runOn: ['retry'] }
        ]
      }
    }
  }
}

/** True when a config exists and is enabled. */
export function isLifecycleEnabled(cfg?: TicketLifecycleConfig | null): boolean {
  return !!cfg && cfg.enabled === true
}

/**
 * The actions configured for `state`/`slot`, filtered by entry context. An action
 * with `runOn` set runs only when `context` is in its list; an action with no
 * `runOn` (or no `context` supplied) always runs. Returns an empty array when none.
 */
export function actionsForSlot(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState,
  slot: LifecycleSlot,
  context?: LifecycleEntryContext
): LifecycleAction[] {
  const actions = cfg?.states?.[state]?.[slot] ?? []
  if (!context) return actions
  return actions.filter((a) => !a.runOn || a.runOn.length === 0 || a.runOn.includes(context))
}

/** The branches configured for `state` (empty array when none). */
export function branchesForState(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState
): LifecycleBranch[] {
  return cfg?.states?.[state]?.branches ?? []
}

/** The loop-breaker cap for `state`, or undefined (no cap). */
export function retryMaxForState(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState
): number | undefined {
  return cfg?.states?.[state]?.retryMax
}

/**
 * Map the existing completion verdict (`{ complete, needsInput, confidence }`) to a
 * lifecycle verdict. `needsInput` wins (the agent is waiting on the user); otherwise
 * a confident `complete` is a pass, anything else is a fail.
 */
export function verdictToLifecycle(
  verdict: { complete: boolean; needsInput: boolean; confidence: number },
  threshold: number
): LifecycleVerdict {
  if (verdict.needsInput) return 'needsInput'
  if (verdict.complete && verdict.confidence >= threshold) return 'pass'
  return 'fail'
}

/**
 * Combine a slot's per-action verdicts into one: the first non-`pass` verdict wins
 * (a single failing action fails the slot), else `pass`. An empty list is `pass`.
 */
export function combineVerdicts(verdicts: LifecycleVerdict[]): LifecycleVerdict {
  return verdicts.find((v) => v !== 'pass') ?? 'pass'
}

/** Outcome of `decideBranch` — what the loop does given a verdict + iteration count. */
export type BranchDecision =
  | { kind: 'advance' }
  | { kind: 'goto'; state: LifecycleState }
  | { kind: 'stuck' }

/**
 * Decide the next move for `state` given `verdict` and the count of fail
 * iterations SO FAR (1-based — includes the current fail). A `pass` (or a verdict
 * with no matching branch, or `goto: 'end'`) → `advance` (the loop has nothing to
 * say; the caller falls back to its default behavior). A matching branch:
 *   - `iteration >= retryMax` → `stuck` (the cap is reached — break the loop)
 *   - otherwise               → `goto` the branch's destination state
 */
export function decideBranch(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState,
  verdict: LifecycleVerdict,
  iteration: number
): BranchDecision {
  if (verdict === 'pass') return { kind: 'advance' }
  const branch = branchesForState(cfg, state).find((b) => b.when === verdict)
  if (!branch || branch.goto === 'end') return { kind: 'advance' }

  const retryMax = retryMaxForState(cfg, state)
  if (typeof retryMax === 'number' && iteration >= retryMax) {
    return { kind: 'stuck' }
  }
  return { kind: 'goto', state: branch.goto }
}

/**
 * Substitute `{{reason}}`, `{{title}}`, and `{{iteration}}` in `template`. When the
 * template has no `{{reason}}` placeholder, the reason is appended so the agent
 * still learns WHY the work was bounced.
 */
export function renderTemplate(
  template: string,
  vars: { reason?: string; title?: string; iteration?: number }
): string {
  const reason = (vars.reason ?? '').trim()
  let out = template
    .split('{{title}}')
    .join(vars.title ?? '')
    .split('{{iteration}}')
    .join(vars.iteration != null ? String(vars.iteration) : '')
  if (out.includes('{{reason}}')) {
    return out.split('{{reason}}').join(reason)
  }
  if (!reason) return out
  out = `${out.trimEnd()}\n\n${reason}`
  return out
}
