import { getRendererRpcClient } from './rpc-client'
import type {
  CompletionCheckProvider,
  CompletionCheckResult,
  ConditionGateCheckResult,
  ReviewContextResult,
  ReviewJudgeContextSource,
  SessionFingerprint
} from '@shared/types/completion'

export interface DetectTicketCompletionParams {
  sessionId: string
  ticketId: string
  /** Char budget for the transcript tail sent to the model. */
  maxChars?: number
  /** AI provider to run the check (defaults to claude-code server-side). */
  provider?: CompletionCheckProvider
  /** Model id forwarded to the provider as an override (empty/undefined → provider default). */
  model?: string
  /** System prompt override for the Watcher (empty/undefined → built-in default). */
  systemPrompt?: string
}

export const completionApi = {
  /**
   * Send the tail of a session's transcript to an AI provider and ask whether
   * the ticket's goal is genuinely complete. Resolves to a result envelope —
   * `{ success: false, error }` on provider/parse failure rather than throwing.
   */
  detectTicketCompletion: async (
    params: DetectTicketCompletionParams
  ): Promise<CompletionCheckResult> =>
    getRendererRpcClient().request<CompletionCheckResult>(
      'completionOps.detectTicketCompletion',
      params
    ),

  /**
   * Stage 2 — condition gate. Send the same transcript tail the Watcher judges to
   * an AI provider and ask it to ROUTE the review's return into
   * pass/fix/needs-human. Resolves to a result envelope — `{ success: false, error }`
   * on provider/parse failure (the engine then blocks for the human, no fail-open).
   */
  detectTicketVerdict: async (params: {
    sessionId: string
    ticketId: string
    maxChars?: number
    provider?: CompletionCheckProvider
    model?: string
    systemPrompt?: string
    /**
     * Gate path (Stage-2): read ONLY the Hive-owned verdict file (with a legacy
     * in-repo fallback). When absent, resolve `{ success: true, noFile: true }`
     * instead of falling back to the transcript LLM — the gate must never LLM-guess
     * a pass.
     */
    fileOnly?: boolean
  }): Promise<ConditionGateCheckResult> =>
    getRendererRpcClient().request<ConditionGateCheckResult>(
      'completionOps.detectTicketVerdict',
      params
    ),

  /**
   * Stage-2 (judge path) — extract the tail of a finished review session to feed a
   * spawned interactive judge CLI as its "Context:", resolve the Hive-owned
   * OUT-OF-REPO `gateFilePath` the judge must write to, and (with `clearGateFile`)
   * remove any stale verdict file first so the judge's fresh write is the only
   * verdict Hive reads. Resolves to `{ success: false, error }` on failure.
   */
  extractReviewContext: async (params: {
    sessionId: string
    ticketId: string
    source?: ReviewJudgeContextSource
    maxChars?: number
    clearGateFile?: boolean
  }): Promise<ReviewContextResult> =>
    getRendererRpcClient().request<ReviewContextResult>(
      'completionOps.extractReviewContext',
      params
    ),

  /**
   * Cheap deterministic snapshot of a session's emitted output (Strict Verify
   * "frozen check"). Prefers the live PTY accumulator; falls back to a coarse
   * message fingerprint for non-PTY providers.
   */
  getSessionFingerprint: async (sessionId: string): Promise<SessionFingerprint> =>
    getRendererRpcClient().request<SessionFingerprint>('completionOps.getSessionFingerprint', {
      sessionId
    }),

  /**
   * Probe whether the configured Strict Verify provider + model are actually
   * callable (CLI installed, model id valid, authenticated). Runs the real
   * Watcher against a canned transcript and resolves to a result envelope —
   * `{ success: false, error }` when the provider can't be reached.
   */
  testStrictVerifyProvider: async (params: {
    provider?: CompletionCheckProvider
    model?: string
    systemPrompt?: string
  }): Promise<CompletionCheckResult> =>
    getRendererRpcClient().request<CompletionCheckResult>(
      'completionOps.testStrictVerifyProvider',
      params
    )
}
