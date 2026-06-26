import { terminalApi } from '@/api/terminal-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { messageSendTimes, userExplicitSendTimes, lastSendMode } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'

/**
 * Headlessly enter a follow-up prompt into a Claude Code CLI session's PTY.
 *
 * This mirrors the `agent_sdk === 'claude-code-cli'` branch of the kanban
 * modal's `sendFollowupToSession`, but without any modal/React state — it can
 * run from a store action (e.g. draining the prompt queue once Strict Verify
 * has verified a ticket complete) when no modal is open.
 *
 * Performs the same "busy now" bookkeeping the modal does (send time, token
 * baseline, working status) so the kanban card shows progress immediately and
 * the completion pipeline times the next settle from this send. Marking the
 * session `working` also emits a `session_working` sync event, which moves the
 * ticket Review → In Progress and clears the stale completion verdict.
 *
 * Returns `true` when the prompt was delivered (or a fresh CLI was spawned with
 * it pending), `false` on a hard failure so the caller can requeue.
 */
export async function dispatchClaudeCliFollowup(
  sessionId: string,
  prompt: string
): Promise<boolean> {
  // Queued follow-ups always resume build work (the verified gate only applies
  // to build tickets); reset the session to build mode so its ticket follows.
  try {
    await useSessionStore.getState().setSessionMode(sessionId, 'build')
  } catch {
    // Non-fatal — the prompt itself is what matters.
  }

  const now = Date.now()
  messageSendTimes.set(sessionId, now)
  userExplicitSendTimes.set(sessionId, now)
  snapshotTokenBaseline(sessionId)
  lastSendMode.set(sessionId, 'build')
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')

  try {
    const delivery = unwrapEnvelope(await terminalApi.sendClaudeCliPrompt(sessionId, prompt))
    if (delivery.delivered) return true

    // No live PTY — relaunch the CLI with this prompt pending so it runs on boot.
    const created = unwrapEnvelope(
      await terminalApi.createClaudeCli(sessionId, { pendingPrompt: prompt })
    )
    if (created.success) return true
  } catch (err) {
    console.error('[claude-cli-followup] dispatch failed for session', sessionId, err)
  }

  // Hard failure — undo the optimistic "busy" status so the card doesn't lie.
  useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
  return false
}
