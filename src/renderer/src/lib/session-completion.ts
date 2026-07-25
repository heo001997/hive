/**
 * Which `completed` statuses actually mean "a turn ended".
 *
 * `completed` is overloaded. Most of its sources are genuine turn ends — the Claude
 * CLI `Stop` hook, `SessionEnd`, a user interrupt (Esc/Ctrl-C), the PTY exiting, an
 * SDK run finishing — and those are what the kanban board's In Progress → Review
 * promotion is built on. But two sources fire when a CLI session *starts*, before
 * any turn has run:
 *
 *   - `reason: 'pty_start'`        — a promptless Claude CLI PTY was just spawned
 *                                    (the "Ready" badge for an idle terminal).
 *   - `hookEventName: 'SessionStart'` — the CLI's own session-start hook, which the
 *                                    hook server maps to `completed` for the same badge.
 *
 * Treating those as turn ends is what made a freshly launched ticket jump straight to
 * Review: the board armed `promoteToReviewWhenQuiescent` at spawn time, and a brand-new
 * session has no output to prove it is alive yet. The badge is still correct (nothing is
 * running *yet*), so the status itself is kept — only the column-moving kanban event is
 * suppressed. Real work then reports `working` (UserPromptSubmit) and the eventual `Stop`
 * promotes the ticket normally.
 */
export function isTurnEndCompletion(metadata?: {
  reason?: string
  hookEventName?: string
}): boolean {
  if (metadata?.reason === 'pty_start') return false
  if (metadata?.hookEventName === 'SessionStart') return false
  return true
}
