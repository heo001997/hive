import { getRendererRpcClient } from './rpc-client'
import type {
  CompletionCheckProvider,
  CompletionCheckResult,
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

/** Result envelope returned by {@link completionApi.getTicketTranscript}. */
export interface GetTicketTranscriptResult {
  success: boolean
  /** The transcript tail (present on success; may be empty when no source had text). */
  text?: string
  error?: string
}

/** The three machine-readable verdicts a `/speckit-review` gate file may carry. */
export type SpeckitGateVerdict = 'pass' | 'fix' | 'needs-human'

/** Result envelope returned by {@link completionApi.getTicketReviewGate}. */
export interface GetTicketReviewGateResult {
  success: boolean
  /** True when `.hive/review-gate.json` existed and parsed into a valid verdict. */
  found: boolean
  verdict?: SpeckitGateVerdict
  reason?: string
  /** Human-readable fix items (only meaningful for verdict `fix`). */
  fixes?: string[]
  error?: string
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
    ),

  /**
   * Fetch the same provider-agnostic transcript tail the Watcher judges, WITHOUT
   * a model call. Used by the Speckit review-gate to scan a settled review
   * ticket's output for a `board-ticket-drafts` block. Resolves to a result
   * envelope — `{ success: false, error }` on failure rather than throwing.
   */
  getTicketTranscript: async (params: {
    sessionId: string
    ticketId: string
    maxChars?: number
  }): Promise<GetTicketTranscriptResult> =>
    getRendererRpcClient().request<GetTicketTranscriptResult>(
      'completionOps.getTicketTranscript',
      params
    ),

  /**
   * Read the Speckit review-gate's deterministic verdict file
   * (`<worktree>/.hive/review-gate.json`) written by `/speckit-review`. No model
   * call, no transcript scrape. `found:false` (absent / unparseable / bad verdict)
   * lets the gate fail safe to needs-Tu. Resolves to an envelope, never throws.
   */
  getTicketReviewGate: async (params: {
    ticketId: string
    sessionId?: string
  }): Promise<GetTicketReviewGateResult> =>
    getRendererRpcClient().request<GetTicketReviewGateResult>(
      'completionOps.getTicketReviewGate',
      params
    )
}
