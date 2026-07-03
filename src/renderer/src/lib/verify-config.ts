/**
 * Resolve the three separable verification components for a single ticket, folding
 * per-ticket overrides (`ticket.verify_overrides`) over the global defaults.
 *
 * The frozen check (deterministic tty-stillness) is the trustworthy liveness gate
 * and runs for every ticket. The other two components differ by ticket TYPE:
 *   - a normal build ticket runs the LLM Strict Reviewer (keeps prose-question
 *     detection) and has no gate loop;
 *   - a gate/review ticket AUTO-SKIPS the LLM Reviewer (its "CHANGES REQUESTED"
 *     prose would read as incomplete and bounce it to In Progress — the exact 2822
 *     bug) and instead runs the Stage-2 Condition Gate after the frozen check.
 *
 * Each component is per-ticket overridable (tri-state: null = use the default
 * above; true/false = force). This is the single source of truth the store's
 * settle handler and the per-ticket UI both read.
 */
import type { KanbanTicket } from '../../../main/db/types'
import { isConditionGate } from './ticket-lifecycle'

/** The global settings the resolver reads (subset of the settings store). */
export interface VerifyGlobalSettings {
  /** Frozen-check master (historically the "Snapshot" sub-gate). */
  kanbanStrictVerifySnapshotEnabled?: boolean
  /** LLM Strict Reviewer (the AI Watcher) master for normal tickets. */
  kanbanStrictVerifyReviewerEnabled?: boolean
  /** Frozen-silence window in seconds (default 5, floored to 2 on resolve). */
  kanbanStrictVerifyFrozenIdleSeconds?: number
}

/** The resolved, ready-to-use verification config for one ticket. */
export interface ResolvedVerifyConfig {
  /** True when this ticket is a two-stage Condition Gate (review→fix loop). */
  isGate: boolean
  /** Component 1 — the deterministic frozen check (always the liveness gate). */
  frozenEnabled: boolean
  /** Component 2 — the LLM Strict Reviewer. Auto-off for gate tickets. */
  llmReviewer: boolean
  /** Component 3 — the Stage-2 gate / review→fix loop. On for gate tickets. */
  gateLoop: boolean
  /** Frozen-silence window in ms (≥2000). */
  frozenIdleMs: number
}

/** Guard for the frozen-idle window: seconds → ms, never below the 2s floor. */
export const MIN_FROZEN_IDLE_MS = 2000
/** Default frozen-silence window (seconds) when nothing is configured. */
export const DEFAULT_FROZEN_IDLE_SECONDS = 5

export function resolveVerifyConfig(
  ticket: Pick<KanbanTicket, 'lifecycle_callbacks' | 'verify_overrides'>,
  settings: VerifyGlobalSettings
): ResolvedVerifyConfig {
  const isGate = isConditionGate(ticket.lifecycle_callbacks)
  const ov = ticket.verify_overrides ?? {}

  const nn = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined

  const frozenEnabled = nn(ov.frozenCheck)
    ? ov.frozenCheck
    : (settings.kanbanStrictVerifySnapshotEnabled ?? true)

  const llmReviewer = nn(ov.llmReviewer)
    ? ov.llmReviewer
    : isGate
      ? false // gate default: the review's prose is routed by Stage-2, not judged by the Watcher
      : (settings.kanbanStrictVerifyReviewerEnabled ?? true)

  const gateLoop = nn(ov.gateLoop) ? ov.gateLoop : isGate

  const idleSeconds = nn(ov.frozenIdleSeconds)
    ? ov.frozenIdleSeconds
    : (settings.kanbanStrictVerifyFrozenIdleSeconds ?? DEFAULT_FROZEN_IDLE_SECONDS)
  const frozenIdleMs = Math.max(MIN_FROZEN_IDLE_MS, idleSeconds * 1000)

  return { isGate, frozenEnabled, llmReviewer, gateLoop, frozenIdleMs }
}
