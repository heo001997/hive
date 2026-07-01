import path from 'node:path'
import { getDatabase } from '../db'
import {
  buildClaudeCliHookSettings,
  getClaudeHookServer,
  getLastClaudeCliStatus,
  publishClaudeCliStatus,
  subscribeClaudeCliStatus,
  type ClaudeCliStatusPayload
} from './claude-hook-server'
import { logClaudeBinaryVersion, resolveClaudeBinaryPath } from './claude-binary-resolver'
import { buildClaudeCliPtySpawn } from './claude-cli-spawner'
import { externalizeGoalHandoffPlan } from './claude-cli-plan-handoff'
import { reassertClaudeCliPromptSubmit, writeClaudeCliPrompt } from './claude-cli-pty-prompt'
import { watchForClaudeSessionId, type ClaudeSessionWatchHandle } from './claude-session-watcher'
import {
  watchForClaudePlanFollowup,
  type ClaudePlanFollowupWatchHandle
} from './claude-plan-followup-watcher'
import {
  applyClaudeCliTitle,
  processClaudeCliPtyData,
  resetAllClaudeCliTitleState,
  resetClaudeCliTitleState
} from './claude-cli-title-handler'
import { ghosttyService } from './ghostty-service'
import { createLogger } from './logger'
import { ptyService } from './pty-service'
import { stripAnsi } from '../../shared/lib/ansi'

const log = createLogger({ component: 'TerminalPtyBridge' })

/** Cap on the rolling liveness tail kept per terminal (ANSI-stripped). */
const LIVENESS_TAIL_CAP = 16 * 1024

const listenerCleanups = new Map<string, { removeData: () => void; removeExit: () => void }>()
const dataBuffers = new Map<string, string>()
/**
 * A non-cleared accumulator of each terminal's emitted output, distinct from
 * `dataBuffers` (which is flushed-and-deleted every tick and therefore only ever
 * holds un-flushed bytes). `bytes` is the running total length observed; `tail`
 * is a capped, ANSI-stripped rolling window of the most recent output. Used by
 * `getTerminalLiveness` to fingerprint whether a session is still emitting.
 */
const terminalLiveness = new Map<string, { bytes: number; raw: string; lastOutputAt: number }>()

/**
 * Append `data` to a terminal's liveness accumulator (never cleared on flush).
 * The rolling tail is stored RAW (with ANSI) and stripped once at read time —
 * PTY `onData` chunks split on arbitrary byte boundaries, so an escape sequence
 * can straddle two chunks; stripping per chunk would leave the split fragment
 * behind. `bytes` is the uncapped running total (the frozen check only needs it
 * to move when output is still being emitted). `lastOutputAt` is the wall-clock
 * ms of THIS emit — the ground-truth "when did the terminal last move a byte"
 * signal the frozen check reads: it ticks on spinner/clock/token bytes too, so
 * ANY change counts as alive (the user's rule: total stillness ⟺ frozen).
 */
function recordTerminalLiveness(terminalId: string, data: string): void {
  const prev = terminalLiveness.get(terminalId)
  const bytes = (prev?.bytes ?? 0) + data.length
  const combined = (prev?.raw ?? '') + data
  const raw = combined.length > LIVENESS_TAIL_CAP ? combined.slice(-LIVENESS_TAIL_CAP) : combined
  terminalLiveness.set(terminalId, { bytes, raw, lastOutputAt: Date.now() })
}

/**
 * Snapshot of a terminal's emitted output so far. For Claude CLI sessions
 * `sessionId === terminalId`, so the lookup is direct. Returns `undefined` when
 * no PTY output has been recorded for this id (e.g. a non-PTY provider) — the
 * caller then falls back to a coarser source. The tail is ANSI-stripped here,
 * once, over the combined buffer (see `recordTerminalLiveness`).
 */
export function getTerminalLiveness(
  terminalId: string
): { bytes: number; tail: string; lastOutputAt: number } | undefined {
  const live = terminalLiveness.get(terminalId)
  if (!live) return undefined
  return { bytes: live.bytes, tail: stripAnsi(live.raw), lastOutputAt: live.lastOutputAt }
}
const flushScheduled = new Set<string>()
const claudeWatchers = new Map<string, ClaudeSessionWatchHandle>()
const claudePlanFollowupWatchers = new Map<string, ClaudePlanFollowupWatchHandle>()
const claudeCliSessions = new Set<string>()
const claudeCliWorktreeBasenames = new Map<string, string>()
const claudeCliTranscriptSources = new Map<
  string,
  { worktreePath: string; claudeSessionId: string | null }
>()
const claudeCliLastStatus = new Map<string, ClaudeCliStatusPayload>()
let unsubscribeClaudeCliStatus: (() => void) | null = null

function closeClaudePlanFollowupWatcher(sessionId: string): void {
  claudePlanFollowupWatchers.get(sessionId)?.close()
  claudePlanFollowupWatchers.delete(sessionId)
}

function armClaudePlanFollowupWatcher(sessionId: string): void {
  const source = claudeCliTranscriptSources.get(sessionId)
  if (!source?.claudeSessionId) return

  closeClaudePlanFollowupWatcher(sessionId)
  claudePlanFollowupWatchers.set(
    sessionId,
    watchForClaudePlanFollowup(source.worktreePath, source.claudeSessionId, () => {
      closeClaudePlanFollowupWatcher(sessionId)
      publishClaudeCliStatus({
        sessionId,
        status: 'planning',
        metadata: { reason: 'claude_cli_plan_followup' }
      })
    })
  )
}

function ensureClaudeCliStatusSubscription(): void {
  if (unsubscribeClaudeCliStatus) return

  unsubscribeClaudeCliStatus = subscribeClaudeCliStatus((payload) => {
    if (!claudeCliSessions.has(payload.sessionId)) return

    claudeCliLastStatus.set(payload.sessionId, payload)
    if (payload.status === 'plan_ready') {
      armClaudePlanFollowupWatcher(payload.sessionId)
      return
    }

    if (
      payload.status === 'working' &&
      payload.metadata?.hookEventName === 'PostToolUse' &&
      payload.metadata.toolName === 'ExitPlanMode'
    ) {
      closeClaudePlanFollowupWatcher(payload.sessionId)
      return
    }

    if (
      payload.status === 'planning' &&
      payload.metadata?.hookEventName === 'PostToolUseFailure' &&
      payload.metadata.toolName === 'ExitPlanMode'
    ) {
      closeClaudePlanFollowupWatcher(payload.sessionId)
    }
  })
}

// Lone Escape / Ctrl+C. A bare Escape keypress arrives as exactly '\x1b';
// multi-byte sequences (arrow keys, bracketed pastes) never match exactly.
const INTERRUPT_KEYS = new Set(['\x1b', '\x03'])
const INTERRUPTIBLE_STATUSES = new Set(['working', 'planning', 'permission'])

/**
 * Claude Code never fires its Stop hook when the user interrupts a running
 * turn with Escape/Ctrl+C, and the CLI keeps running so the pty_exit fallback
 * never fires either — the session would stay stuck on 'working'. Mirror the
 * keypress itself into a status update instead. plan_ready/answering are
 * excluded: escaping those dialogs fires PostToolUseFailure hooks that the
 * existing pipeline already handles.
 */
export function handleClaudeCliTerminalInput(terminalId: string, data: string): void {
  if (!claudeCliSessions.has(terminalId)) return
  if (!INTERRUPT_KEYS.has(data)) return
  const last = getLastClaudeCliStatus(terminalId)
  if (!last || !INTERRUPTIBLE_STATUSES.has(last)) return
  publishClaudeCliStatus({
    sessionId: terminalId,
    status: 'completed',
    metadata: { reason: 'user_interrupt' }
  })
}

export function destroyNodePtyTerminal(terminalId: string): void {
  const cleanup = listenerCleanups.get(terminalId)
  if (cleanup) {
    cleanup.removeData()
    cleanup.removeExit()
    listenerCleanups.delete(terminalId)
  }
  dataBuffers.delete(terminalId)
  terminalLiveness.delete(terminalId)
  flushScheduled.delete(terminalId)
  claudeWatchers.get(terminalId)?.close()
  claudeWatchers.delete(terminalId)
  closeClaudePlanFollowupWatcher(terminalId)
  claudeCliSessions.delete(terminalId)
  claudeCliWorktreeBasenames.delete(terminalId)
  claudeCliTranscriptSources.delete(terminalId)
  claudeCliLastStatus.delete(terminalId)
  resetClaudeCliTitleState(terminalId)
  ptyService.destroy(terminalId)
}

function attachNodePtyListeners(terminalId: string): void {
  const existing = listenerCleanups.get(terminalId)
  if (existing) {
    existing.removeData()
    existing.removeExit()
    listenerCleanups.delete(terminalId)
  }

  const removeData = ptyService.onData(terminalId, (data) => {
    const existing = dataBuffers.get(terminalId)
    dataBuffers.set(terminalId, existing ? existing + data : data)
    // Liveness accumulator: unlike dataBuffers above, this is NOT cleared on flush.
    recordTerminalLiveness(terminalId, data)

    if (claudeCliSessions.has(terminalId)) {
      const title = processClaudeCliPtyData(terminalId, data, {
        worktreeBasename: claudeCliWorktreeBasenames.get(terminalId)
      })
      if (title) {
        applyClaudeCliTitle({
          sessionId: terminalId,
          title,
          db: getDatabase()
        }).catch(() => {
          // applyClaudeCliTitle logs and swallows internally.
        })
      }
    }

    if (!flushScheduled.has(terminalId)) {
      flushScheduled.add(terminalId)
      setImmediate(() => {
        flushScheduled.delete(terminalId)
        const buffered = dataBuffers.get(terminalId)
        dataBuffers.delete(terminalId)
        if (buffered) {
          void import('../desktop/backend-event-publisher')
            .then(({ publishDesktopBackendEvent }) =>
              publishDesktopBackendEvent(`terminal:data:${terminalId}`, buffered)
            )
            .catch(() => undefined)
        }
      })
    }
  })

  const removeExit = ptyService.onExit(terminalId, (code) => {
    void import('../desktop/backend-event-publisher')
      .then(({ publishDesktopBackendEvent }) =>
        publishDesktopBackendEvent(`terminal:exit:${terminalId}`, code)
      )
      .catch(() => undefined)
    listenerCleanups.delete(terminalId)
    dataBuffers.delete(terminalId)
    terminalLiveness.delete(terminalId)
    flushScheduled.delete(terminalId)
    claudeWatchers.get(terminalId)?.close()
    claudeWatchers.delete(terminalId)
    closeClaudePlanFollowupWatcher(terminalId)
    if (claudeCliSessions.has(terminalId)) {
      publishClaudeCliStatus({
        sessionId: terminalId,
        status: 'completed',
        metadata: { reason: 'pty_exit' }
      })
      claudeCliSessions.delete(terminalId)
    }
    claudeCliWorktreeBasenames.delete(terminalId)
    claudeCliTranscriptSources.delete(terminalId)
    claudeCliLastStatus.delete(terminalId)
    resetClaudeCliTitleState(terminalId)
  })

  listenerCleanups.set(terminalId, { removeData, removeExit })
}

export async function createClaudeCliTerminal(
  sessionId: string,
  opts?: { pendingPrompt?: string | null }
): Promise<{ success: boolean; cols?: number; rows?: number; error?: string }> {
  let pendingPrompt = opts?.pendingPrompt ?? null
  log.info('RPC: terminalOps.createClaudeCli', { sessionId, hasPrompt: !!pendingPrompt })
  try {
    const db = getDatabase()
    const session = db.getSession(sessionId)
    if (!session) {
      return { success: false, error: 'Session not found' }
    }
    if (session.agent_sdk !== 'claude-code-cli') {
      return { success: false, error: 'Session is not a Claude Code CLI session' }
    }

    let worktreePath: string | null = null
    if (session.worktree_id) {
      worktreePath = db.getWorktree(session.worktree_id)?.path ?? null
    } else if (session.connection_id) {
      worktreePath = db.getConnection(session.connection_id)?.path ?? null
    }
    if (!worktreePath) {
      return { success: false, error: 'Could not resolve session working directory' }
    }

    // Oversized claude-cli goal-mode handoffs are rejected (>~4k chars). Externalize the
    // plan to PLAN_{uuid}.md in the worktree and send a short reference instead. Runs before
    // both delivery paths below (spawn args and paste injection).
    if (pendingPrompt) {
      pendingPrompt = externalizeGoalHandoffPlan(pendingPrompt, worktreePath)
    }

    const claudeBinary = resolveClaudeBinaryPath()
    if (!claudeBinary) {
      return { success: false, error: 'Claude binary not found on PATH' }
    }
    logClaudeBinaryVersion(claudeBinary)

    const alreadyExists = ptyService.has(sessionId)
    const { port } = await getClaudeHookServer()
    ensureClaudeCliStatusSubscription()
    const hookSettingsJson = buildClaudeCliHookSettings(port, sessionId)
    const spawn = buildClaudeCliPtySpawn({
      session,
      worktreePath,
      pendingPrompt,
      claudeBinary,
      hookSettingsJson,
      db
    })

    log.info('Creating Claude CLI PTY', {
      sessionId,
      command: spawn.command,
      args: spawn.args.map((arg, index) =>
        index === spawn.args.length - 1 && pendingPrompt ? '<prompt>' : arg
      )
    })

    if (!session.claude_session_id) {
      claudeWatchers.get(sessionId)?.close()
      claudeWatchers.set(
        sessionId,
        watchForClaudeSessionId(worktreePath, (claudeSessionId) => {
          try {
            db.updateSession(sessionId, { claude_session_id: claudeSessionId })
          } catch (error) {
            log.warn('Failed to persist Claude CLI session id', {
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            })
          }
          void import('../desktop/backend-event-publisher')
            .then(({ publishDesktopBackendEvent }) =>
              publishDesktopBackendEvent(`terminal:claude-session-id:${sessionId}`, claudeSessionId)
            )
            .catch(() => undefined)
          claudeCliTranscriptSources.set(sessionId, { worktreePath, claudeSessionId })
          if (claudeCliLastStatus.get(sessionId)?.status === 'plan_ready') {
            armClaudePlanFollowupWatcher(sessionId)
          }
          claudeWatchers.delete(sessionId)
        })
      )
    }
    claudeCliTranscriptSources.set(sessionId, {
      worktreePath,
      claudeSessionId: session.claude_session_id
    })

    const { cols, rows } = ptyService.create(sessionId, {
      cwd: spawn.cwd,
      command: spawn.command,
      args: spawn.args,
      env: spawn.env
    })
    if (alreadyExists && pendingPrompt) {
      // ptyService.create reused the live PTY, so the spawn args (and the
      // prompt riding on them) never reached claude. Inject it as a paste so
      // a racing promptless create call can't strand the prompt.
      const { delivered } = writeClaudeCliPrompt(sessionId, pendingPrompt)
      if (delivered) {
        // The paste can land before claude's TUI is input-ready, which buffers
        // the text but drops the submitting CR — leaving the prompt sitting
        // unsent. Re-assert Enter across the boot window so it actually submits.
        reassertClaudeCliPromptSubmit(sessionId)
      }
      log.info('Claude CLI PTY already exists; injecting pending prompt', {
        sessionId,
        delivered
      })
    }
    claudeCliSessions.add(sessionId)
    claudeCliWorktreeBasenames.set(sessionId, path.basename(worktreePath))
    if (!pendingPrompt) {
      publishClaudeCliStatus({
        sessionId,
        status: 'completed',
        metadata: { reason: 'pty_start' }
      })
    }

    if (!alreadyExists) {
      attachNodePtyListeners(sessionId)
    }

    return { success: true, cols, rows }
  } catch (error) {
    log.error(
      'RPC: terminalOps.createClaudeCli failed',
      error instanceof Error ? error : new Error(String(error)),
      { sessionId }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function cleanupTerminals(): Promise<void> {
  log.info('Cleaning up all terminals')
  for (const [, cleanup] of listenerCleanups) {
    cleanup.removeData()
    cleanup.removeExit()
  }
  listenerCleanups.clear()
  dataBuffers.clear()
  terminalLiveness.clear()
  flushScheduled.clear()
  for (const [, watcher] of claudeWatchers) {
    watcher.close()
  }
  claudeWatchers.clear()
  for (const [, watcher] of claudePlanFollowupWatchers) {
    watcher.close()
  }
  claudePlanFollowupWatchers.clear()
  claudeCliSessions.clear()
  claudeCliWorktreeBasenames.clear()
  claudeCliTranscriptSources.clear()
  claudeCliLastStatus.clear()
  unsubscribeClaudeCliStatus?.()
  unsubscribeClaudeCliStatus = null
  resetAllClaudeCliTitleState()
  // Awaited group teardown (SIGTERM → grace → SIGKILL) so PTY leaders are gone
  // before the app exits, instead of reparenting to PID 1 en masse on quit/relaunch.
  await ptyService.destroyAllGraceful()
  ghosttyService.shutdown()
}
