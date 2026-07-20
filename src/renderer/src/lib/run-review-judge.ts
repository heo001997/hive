import { terminalApi } from '@/api/terminal-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { useSessionStore } from '@/stores/useSessionStore'
import type { SelectedModel } from '@/stores/useSettingsStore'

/**
 * Compose the full prompt handed to the Stage-2 review-judge CLI: the user-editable
 * "review standard" prompt, the extracted review-session context tail under a
 * `Context:` header, and — when Hive supplies one — an authoritative OUTPUT
 * directive naming the EXACT absolute file the judge must write its verdict to:
 *
 *     {standard prompt}
 *
 *     Context:
 *     {last N chars of the review session…}
 *
 *     --- OUTPUT (write verdict JSON to <gateFilePath>)
 *
 * `gateFilePath` lives OUTSIDE the reviewed repo (under the Hive data dir), so the
 * verdict file never pollutes the user's `git status`. The directive is stated as
 * authoritative so it overrides any path a custom standard prompt happens to name;
 * omitting it (legacy callers / tests) yields the plain `{standard}\n\nContext:`.
 */
export function buildJudgePrompt(
  standardPrompt: string,
  context: string,
  gateFilePath?: string
): string {
  const standard = standardPrompt.trim()
  const ctx = context.trim()
  const base = `${standard}\n\nContext:\n${ctx}`
  const target = gateFilePath?.trim()
  if (!target) return base
  return (
    `${base}\n\n` +
    `--- OUTPUT (Hive gate contract — this overrides any file path named above)\n` +
    `Write your verdict JSON to EXACTLY this absolute path, and to NO other file ` +
    `(create parent directories if they do not exist):\n${target}\n` +
    `Do NOT write any file inside the repository. Write only the JSON object, then stop.`
  )
}

/**
 * Resolve the reviewed session's model into a `modelOverride` so the spawned judge
 * INHERITS the ticket's model (the user's choice) rather than falling back to the
 * global default. Returns undefined when the reviewed session has no stored model
 * (then `createSession` uses its normal default resolution).
 */
function inheritedModelOverride(reviewedSessionId: string | null): SelectedModel | undefined {
  if (!reviewedSessionId) return undefined
  const session = useSessionStore.getState().getSessionById(reviewedSessionId)
  if (!session?.model_provider_id || !session.model_id) return undefined
  return {
    providerID: session.model_provider_id,
    modelID: session.model_id,
    variant: session.model_variant ?? undefined
  }
}

/**
 * Spawn a brand-new interactive Claude Code CLI ("the judge") in the reviewed
 * worktree and hand it the composed judge prompt. The judge reads the review
 * session's context, decides the verdict, and WRITES the Hive-owned verdict file
 * named in the prompt's OUTPUT directive (an absolute path OUTSIDE the repo) —
 * which the Condition Gate then reads and routes.
 *
 * This is the SAME interactive CLI Hive already uses everywhere (createSession →
 * createClaudeCli PTY path), NOT a headless `claude -p` — an interactive CLI can't
 * return structured stdout, so the verdict transport is the file it writes.
 *
 * Mirrors {@link dispatchCreatePrViaClaudeCli}: the prompt lives in the session's
 * pending-message queue and whichever `createClaudeCli` call dequeues it first
 * delivers it (never entered twice). The judge session is surfaced INLINE in the
 * ticket's detail view (view-only) so the user can watch it judge without being
 * yanked to the worktree screen.
 *
 * Returns the new judge session id on success so the caller can await the judge
 * going frozen (its terminal falling silent) before reading the verdict file.
 */
export async function dispatchReviewJudge(opts: {
  worktreeId: string
  projectId: string
  ticketId: string
  /** Composed prompt (standard + `Context:` tail) — see {@link buildJudgePrompt}. */
  prompt: string
  /** The reviewed session whose model the judge should inherit. */
  reviewedSessionId: string | null
}): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  const { worktreeId, projectId, ticketId, prompt, reviewedSessionId } = opts

  const sessionStore = useSessionStore.getState()
  const result = await sessionStore.createSession(worktreeId, projectId, 'claude-code-cli', 'build', {
    autoFocus: false,
    skipKanbanAutoAttach: true,
    modelOverride: inheritedModelOverride(reviewedSessionId),
    pendingMessage: prompt,
    nameOverride: 'Review Judge'
  })
  if (!result.success || !result.session) {
    return { success: false, error: result.error ?? 'Failed to create the judge terminal' }
  }

  const newSessionId = result.session.id
  // Show the judge inline in the ticket's tab strip (view-only) so the user can
  // watch it work while the ticket stays put in Review.
  sessionStore.setTicketActiveView(ticketId, newSessionId)

  // Claim the queued prompt before spawning so the session view's mount path
  // doesn't also deliver it (double-entry). Whoever wins the PTY spawn carries it.
  const outboundPrompt = sessionStore.dequeuePendingMessage(newSessionId)
  try {
    const cliResult = unwrapEnvelope(
      await terminalApi.createClaudeCli(newSessionId, { pendingPrompt: outboundPrompt })
    )
    if (!cliResult.success) {
      if (outboundPrompt) sessionStore.requeuePendingMessage(newSessionId, outboundPrompt)
      return { success: false, error: cliResult.error ?? 'Failed to start the judge CLI' }
    }
  } catch (err) {
    if (outboundPrompt) sessionStore.requeuePendingMessage(newSessionId, outboundPrompt)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  return { success: true, sessionId: newSessionId }
}
