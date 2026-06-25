/**
 * Shared types for AI-assisted ticket-completion detection: the renderer sends
 * a session's transcript tail to an AI provider (via the `completionOps` RPC
 * domain) which judges whether the ticket's goal is genuinely complete.
 */

/** The AI providers that can run a completion check (the text-generation router's set). */
export const COMPLETION_CHECK_PROVIDERS = ['claude-code', 'codex', 'opencode'] as const
export type CompletionCheckProvider = (typeof COMPLETION_CHECK_PROVIDERS)[number]

/** Human-facing label for each provider, used in settings UI. */
export const COMPLETION_PROVIDER_LABELS: Record<CompletionCheckProvider, string> = {
  'claude-code': 'Claude Code (Anthropic)',
  codex: 'Codex (OpenAI)',
  opencode: 'opencode'
}

/**
 * Default system prompt for the Ticket Reviewer (Gate 2, the AI Watcher). Lives
 * in shared so the main-process detector uses it as the fallback AND the renderer
 * settings UI can seed/reset the user-editable prompt to exactly this text.
 *
 * IMPORTANT: a custom prompt MUST still instruct the model to return the JSON
 * object with keys complete/needsInput/confidence/reason, or the verdict can't be
 * parsed (the engine then fails open and leaves the ticket in Review).
 */
export const DEFAULT_STRICT_VERIFY_PROMPT = `You decide whether an AI coding agent has finished the work a ticket asked for.

You are given a ticket (the goal) and the TAIL END of the agent's transcript. The agent has stopped. TRUST THE TRANSCRIPT REPORTED BY THE AGENT: judge completion from what the agent actually says and shows at the end. If the agent reports the work done — even if it also lists optional follow-ups, nice-to-haves, or things someone "could" do later — treat the ticket as complete, because those extras were not required.

Do NOT demand proof of process. The ticket's deliverable is what matters, not the steps taken to get there. Missing evidence that the agent read a file, opened a linked card, ran a particular command, or followed a suggested workflow is NOT grounds for "incomplete" — only the result counts. Absence of evidence is not evidence of failure.

Return ONLY a JSON object with keys:
- "complete": boolean — true if the transcript indicates the ticket's deliverable is finished
- "needsInput": boolean — true when the agent is NOT done because it is waiting on the user: asking a question, presenting a choice/selection, requesting a value to fill in, or otherwise blocked pending the user's reply
- "confidence": number between 0 and 1 — how sure you are of the "complete" value
- "reason": a single short sentence (no newlines) justifying the verdict

Rules:
- Default to trusting a stated or shown completion. Mark "complete": true unless the tail gives POSITIVE evidence the core work is unfinished.
- Optional/remaining items, suggested next steps the agent is NOT required to do, and "you could also…" notes do NOT make it incomplete.
- Treat as NOT complete only on real signals the deliverable itself is unfinished: unresolved errors or stack traces at the end, tests reported failing, the agent explicitly says it stopped partway / "I'll continue", required work plainly still pending, or an empty/contentless tail.
- "complete" and "needsInput" are mutually exclusive: if the agent is asking the user something, set complete=false and needsInput=true.
- Set needsInput=true ONLY when the agent is genuinely waiting on a human reply (a question, a selection prompt, a fill-in request). An agent that simply stopped is not waiting on input (needsInput=false).
- Output the JSON object and nothing else.`

export interface CompletionVerdict {
  /** True only if the ticket's goal is convincingly satisfied. */
  complete: boolean
  /**
   * True when the agent is NOT done because it is waiting on the user — asking a
   * question, offering a selection, requesting a fill-in. Distinct from a plain
   * "incomplete": the work isn't wrong, it's blocked on input.
   */
  needsInput: boolean
  /** Model's self-reported confidence in `complete`, in [0, 1]. */
  confidence: number
  /** One-sentence justification (no newlines). */
  reason: string
}

/**
 * A cheap, deterministic snapshot of a session's emitted output. The Strict
 * Verify "frozen check" (Gate 1) captures one when the ticket settles into
 * Review (S0) and another after the settle delay (S1); if they differ the
 * session is still emitting (not done) and the ticket is bounced back without
 * spending a model call.
 */
export interface SessionFingerprint {
  /** Total bytes/characters of output observed so far. */
  length: number
  /** sha256 of the (ANSI-stripped) output tail. */
  hash: string
}

/**
 * Live status of the settle → verify → bypass pipeline for a ticket sitting in
 * Review, surfaced on the Kanban card so the user can watch the countdown and
 * the work happen. Transient (never persisted), keyed by ticketKey.
 *
 *   verify-countdown — D1 ticking; the frozen check + Watcher run when it fires.
 *   checking         — the two gates are running (no fixed duration).
 *   bypass-countdown — D2 ticking; the auto-commit + advance run when it fires.
 *   finalizing       — committing the worktree / advancing to Done.
 */
export type VerifyPhase = 'verify-countdown' | 'checking' | 'bypass-countdown' | 'finalizing'

export interface VerifyProgress {
  phase: VerifyPhase
  /** Epoch ms (Date.now) the active countdown fires. Present only for the *-countdown phases. */
  deadline?: number
}

/** Result envelope returned by the `completionOps.detectTicketCompletion` RPC. */
export interface CompletionCheckResult {
  success: boolean
  verdict?: CompletionVerdict
  error?: string
}

/** Verdict plus the bookkeeping the renderer keeps to render badges and avoid re-checks. */
export interface StoredCompletionVerdict extends CompletionVerdict {
  /** Session the verdict was computed from (re-check only when a newer settle occurs). */
  sessionId: string | null
  /** ms timestamp (Date.now) the verdict was recorded. */
  checkedAt: number
  /** True when the engine moved the ticket back to In Progress because of this verdict. */
  movedBack: boolean
  /**
   * True once the In Progress rescue watcher has exhausted its retries: the
   * session went frozen while the ticket sat "Not done" in In Progress, the
   * watcher re-promoted it to Review the maximum number of times, and it still
   * judged not-done — so the ticket is left in In Progress with a "Re-checked"
   * label instead of looping forever.
   */
  rescueExhausted?: boolean
}
