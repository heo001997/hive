import http from 'http'
import type { SessionStatusType } from '@shared/types/session-status'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { createLogger } from './logger'
import { cliHookTransportRouter } from './cli-hook-transport-router'
import { handleClaudeCliHiveTelemetryHook } from './hive-enterprise-claude-cli-telemetry'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export interface ParsedClaudeHook {
  hook_event_name?: string
  tool_name?: string
  permission_mode?: string
  prompt?: unknown
  transcript_path?: unknown
  tool_input?: {
    plan?: unknown
    questions?: unknown
  }
  /** Final assistant message of the turn (Stop hook). Read both spellings: */
  assistant_message?: string
  last_assistant_message?: string
}

export interface ClaudeCliStatusPayload {
  sessionId: string
  status: SessionStatusType
  metadata?: {
    reason?: string
    hookEventName?: string
    hookPath?: string
    toolName?: string
    plan?: string
  }
}

const log = createLogger({ component: 'ClaudeHookServer' })
const host = '127.0.0.1'
let server: http.Server | null = null
let boundPort: number | null = null
let startingPromise: Promise<{ port: number }> | null = null
const lastStatusBySession = new Map<string, SessionStatusType>()
const statusSubscribers = new Set<(payload: ClaudeCliStatusPayload) => void>()
// Sessions whose first UserPromptSubmit we've already announced (so the
// "automatically create ticket" feature fires at most once per session). The
// renderer's getBySession idempotency check is the real guard; this just keeps
// us from re-emitting on every prompt.
const firstPromptAnnounced = new Set<string>()

// Sub-agent accounting, per session. Claude Code fires SubagentStart when the
// main agent spawns a sub-agent and SubagentStop when it finishes — a matched
// pair that is the in-flight counter. Both POST to THIS session's hook URL (the
// sub-agent inherits the same injected settings.json), so the counter reflects
// how many sub-agents are running for the main session. (The sub-agent DISPATCH
// tool fire is an extra liveness ping at dispatch time but does NOT touch the
// count.)
//
// A main-turn `Stop` that arrives while a sub-agent is still running does NOT
// mean the session finished: the main agent is WAITING on the sub-agent (it
// resumes once the sub-agent returns, and for a background/async sub-agent the
// main turn ends first). Reporting 'completed' there lets the kanban board
// treat the terminal as frozen and promote the ticket to Review while work is
// still in flight — the "incorrect review state". So a Stop is DEFERRED (kept
// 'working') until the last SubagentStop. See resolveClaudeCliHookOutcome.
//
// The deferred value is the KIND of stop (`Stop` vs `StopFailure`), not just a
// flag: the two route to different kanban columns (a clean finish → Review, an
// API-error turn → Human Require), so when the last SubagentStop finally
// resolves the deferral we must report the ORIGINAL event, not `SubagentStop`.
const subagentDepthBySession = new Map<string, number>()
const stopDeferredBySession = new Map<string, 'Stop' | 'StopFailure'>()

/**
 * Tool names Claude Code uses to dispatch a sub-agent. The tool was renamed
 * `Task` → `Agent`; a matcher registered as `Task` still fires for it (the CLI
 * keeps the legacy alias for hook matchers) but the hook BODY reports
 * `tool_name: 'Agent'`, so the body-side check must accept both spellings or the
 * dispatch-time liveness ping is silently dropped. Verified against Claude Code
 * 2.1.220: `PreToolUse` → `{ hook_event_name: 'PreToolUse', tool_name: 'Agent' }`.
 */
const SUBAGENT_DISPATCH_TOOLS = new Set(['Agent', 'Task'])

function hookUrl(port: number, hiveSessionId: string, path: string): string {
  return `http://${host}:${port}/hook/${encodeURIComponent(hiveSessionId)}/${path}`
}

/**
 * Every Claude Code hook event (per code.claude.com/docs/en/hooks.md) routed to
 * this local server, EXCEPT `MessageDisplay` — that one fires per streamed text
 * chunk and would flood the server with zero status value. Events are grouped by
 * the endpoint path they POST to (`hookPath`, a label carried in the status
 * metadata); the actual status decision keys off `hook_event_name` in the body,
 * not the path — see `resolveClaudeCliStatus` / `mapHookEventToStatus`.
 *
 * Not every hook maps to a session status: the notify-only / environment events
 * (Notification, Task*, ConfigChange, WorktreeCreate, …) resolve to `null` and
 * are still delivered so the transport relay + telemetry see the full stream and
 * so a status mapping can be added later without re-touching the CLI settings.
 */
export function buildClaudeCliHookSettings(port: number, hiveSessionId: string): string {
  // Matcher-less registration (fires for all invocations of the event).
  const at = (path: string): { hooks: { type: string; url: string }[] }[] => [
    { hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, path) }] }
  ]
  // A single matcher-scoped registration.
  const matched = (
    matcher: string,
    path: string
  ): { matcher: string; hooks: { type: string; url: string }[] } => ({
    matcher,
    hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, path) }]
  })

  return JSON.stringify({
    hooks: {
      // ── Session lifecycle ──
      SessionStart: at('session'),
      SessionEnd: at('session'),
      Setup: at('session'),

      // ── Prompt / turn boundary ──
      UserPromptSubmit: at('start'),
      UserPromptExpansion: at('start'),
      Stop: at('stop'),
      // Turn ended on an API error (rate limit / overload / auth). Treated like a
      // Stop so the ticket surfaces for a human instead of stranding In Progress.
      StopFailure: at('stop'),

      // ── Sub-agents ── the counter pair that keeps a ticket In Progress while a
      // Task sub-agent runs (a Stop mid-sub-agent is deferred, not 'completed').
      SubagentStart: at('subagent'),
      SubagentStop: at('subagent'),

      // ── Tool activity ──
      PreToolUse: [
        // ExitPlanMode drives the 'plan_ready' badge + carries the plan text for
        // the in-app plan card / auto-approve. Answered immediately; the plan menu
        // stays in the native terminal, never held or lifted into the app.
        matched('ExitPlanMode', 'tool'),
        // AskUserQuestion blocks the turn on a user answer — the fire marks the
        // ticket human-blocked ('answering' → Human Require column). The question
        // menu still renders/answers in the native terminal.
        matched('AskUserQuestion', 'permission'),
        // A sub-agent dispatch — a liveness signal at invoke time (the
        // SubagentStart/Stop pair owns the actual in-flight count). One regex
        // matcher covers the current tool name (`Agent`) and the legacy one
        // (`Task`) so this keeps firing on either CLI generation.
        matched('Agent|Task', 'tool')
      ],
      PostToolUse: [matched('*', 'tool')],
      PostToolUseFailure: [matched('*', 'tool')],
      PostToolBatch: at('tool'),
      PermissionDenied: [matched('*', 'tool')],

      // ── Waiting on a human ──
      PermissionRequest: [matched('*', 'permission')],
      Elicitation: [matched('*', 'permission')],
      ElicitationResult: [matched('*', 'permission')],

      // ── Context compaction ── (agent is busy, tty goes quiet → keep 'working')
      PreCompact: at('compact'),
      PostCompact: at('compact'),

      // ── Notify-only / environment ── routed for transcript + telemetry; no
      // session-status mapping (resolve to null).
      Notification: at('event'),
      // MessageDisplay fires per streamed text chunk. Registered for completeness
      // but fast-acked in handleHook (no status / telemetry / transport work) so
      // the hot loop can't hammer this server.
      MessageDisplay: at('event'),
      TaskCreated: at('event'),
      TaskCompleted: at('event'),
      TeammateIdle: at('event'),
      InstructionsLoaded: at('event'),
      ConfigChange: at('event'),
      CwdChanged: at('event'),
      FileChanged: at('event'),
      WorktreeCreate: at('event'),
      WorktreeRemove: at('event')
    }
  })
}

export function mapHookEventToStatus(hook: ParsedClaudeHook): SessionStatusType | null {
  switch (hook.hook_event_name) {
    case 'SessionStart':
    case 'SessionEnd':
    case 'Stop':
      return 'completed'
    case 'UserPromptSubmit':
      return hook.permission_mode === 'plan' ? 'planning' : 'working'
    case 'PreToolUse':
      if (hook.tool_name === 'ExitPlanMode') return 'plan_ready'
      // AskUserQuestion blocks the turn waiting on the user. The question menu
      // renders in the native terminal (it is NOT lifted into an app panel — see
      // the CLI hold-core), and the terminal can fall silent while it waits, so the
      // PreToolUse fire is the signal that the agent is now human-blocked. Reports
      // 'answering' → the renderer routes it to the Human Require column; the
      // matching PostToolUse{AskUserQuestion} → 'working' resumes it to In Progress.
      if (hook.tool_name === 'AskUserQuestion') return 'answering'
      return null
    case 'PostToolUseFailure':
      if (hook.tool_name === 'ExitPlanMode') return 'planning'
      return 'working'
    case 'PostToolUse':
    case 'PostToolBatch':
    case 'PermissionDenied':
      // A denied tool call / resolved batch → the agent keeps going.
      return 'working'
    case 'PermissionRequest':
      if (hook.tool_name === 'ExitPlanMode') return 'plan_ready'
      return 'permission'
    // MCP asked the user for input mid-tool → waiting on a human (like a
    // permission prompt); the reply resumes work.
    case 'Elicitation':
      return 'permission'
    case 'ElicitationResult':
      return 'working'
    // Context compaction: the agent is busy and the tty falls quiet — must read
    // as 'working' so the quiet window is not mistaken for a finished session.
    case 'PreCompact':
    case 'PostCompact':
      return 'working'
    default:
      return null
  }
}

/**
 * What a hook resolved to: the session status plus — when the resolution is not a
 * 1:1 reading of the hook that arrived — the event name the status must be
 * REPORTED as. The renderer routes on `metadata.hookEventName` (StopFailure →
 * Human Require, Stop-in-plan-mode → plan_ready), so a status that a *different*
 * hook resolves on behalf of has to carry the original event's name or the
 * routing silently degrades to the generic completed→Review path.
 */
export interface ClaudeCliHookOutcome {
  status: SessionStatusType | null
  /** Overrides `metadata.hookEventName` when set (see {@link ClaudeCliHookOutcome}). */
  reportAs?: 'Stop' | 'StopFailure'
}

/**
 * Stateful wrapper over the pure {@link mapHookEventToStatus} that layers
 * sub-agent lifecycle awareness on top. Its whole job is to stop a main-turn
 * `Stop` — fired while a sub-agent is still running — from being reported as
 * 'completed'. The main session is WAITING on the sub-agent, not finished; a
 * premature 'completed' lets the kanban board see a quiet terminal and promote the
 * ticket to Review mid-work (the "incorrect review state").
 *
 * Rules (see `subagentDepthBySession`):
 *   SubagentStart    → a sub-agent spawned: depth++, report 'working'.
 *   SubagentStop     → a sub-agent finished: depth-- (floored at 0). Reports
 *                      'completed' only when the LAST sub-agent stops AND a main
 *                      Stop was already deferred — reported AS that original
 *                      Stop/StopFailure so the renderer's error / plan routing
 *                      still applies. Otherwise 'working' (the main agent resumes
 *                      to consume the result, or other sub-agents run on) — except
 *                      for an UNTRACKED SubagentStop (no sub-agent was counted),
 *                      which reports nothing at all: it is not evidence the main
 *                      agent is working, and resurrecting 'working' there would
 *                      drag an already-settled ticket back to In Progress (e.g. the
 *                      trailing SubagentStop of a sub-agent the user interrupted).
 *   Stop / StopFailure → main turn ended (normally or on an API error): deferred
 *                      to 'working' while any sub-agent is in flight (depth > 0),
 *                      else 'completed'.
 *   PreToolUse{Agent|Task} → liveness ping at dispatch ('working'); does not count.
 *   UserPromptSubmit → fresh turn: clear stale bookkeeping (guards against a
 *                      SubagentStop we never received, e.g. an interrupt).
 * Everything else defers to the pure mapper.
 */
export function resolveClaudeCliHookOutcome(
  sessionId: string,
  hook: ParsedClaudeHook
): ClaudeCliHookOutcome {
  switch (hook.hook_event_name) {
    case 'UserPromptSubmit':
      resetSubagentTracking(sessionId)
      return { status: mapHookEventToStatus(hook) }

    case 'PreToolUse':
      // Liveness only — the SubagentStart/SubagentStop pair owns the in-flight
      // count. A sub-agent dispatch marks the session busy the instant it fires.
      if (hook.tool_name && SUBAGENT_DISPATCH_TOOLS.has(hook.tool_name)) {
        return { status: 'working' }
      }
      return { status: mapHookEventToStatus(hook) }

    case 'SubagentStart':
      subagentDepthBySession.set(sessionId, (subagentDepthBySession.get(sessionId) ?? 0) + 1)
      return { status: 'working' }

    case 'SubagentStop': {
      const tracked = subagentDepthBySession.get(sessionId) ?? 0
      // Nothing was in flight for this session — an untracked / duplicate stop.
      // Report no status (see the rules above): it must not revive 'working'.
      if (tracked === 0) return { status: null }

      const depth = tracked - 1
      if (depth === 0) subagentDepthBySession.delete(sessionId)
      else subagentDepthBySession.set(sessionId, depth)
      // The whole process is idle only once the last sub-agent stops AND the
      // main turn has already ended (a Stop we deferred). Until then the main
      // agent is still working (it resumes to consume the sub-agent result).
      if (depth === 0) {
        const deferred = stopDeferredBySession.get(sessionId)
        if (deferred) {
          stopDeferredBySession.delete(sessionId)
          return { status: 'completed', reportAs: deferred }
        }
      }
      return { status: 'working' }
    }

    // A normal turn end (Stop) and an API-error turn end (StopFailure) both mean
    // "the main turn is over" — deferred while a sub-agent is still running.
    case 'Stop':
    case 'StopFailure':
      if ((subagentDepthBySession.get(sessionId) ?? 0) > 0) {
        // A sub-agent is still running; the main agent is WAITING on it, not
        // done. Defer completion until the last SubagentStop resolves it, keeping
        // WHICH kind of stop it was so the eventual report routes correctly.
        stopDeferredBySession.set(sessionId, hook.hook_event_name)
        return { status: 'working' }
      }
      return { status: 'completed' }

    default:
      return { status: mapHookEventToStatus(hook) }
  }
}

/**
 * Status-only view of {@link resolveClaudeCliHookOutcome} (the `reportAs` override
 * is dropped). Kept for callers that only need the status.
 */
export function resolveClaudeCliStatus(
  sessionId: string,
  hook: ParsedClaudeHook
): SessionStatusType | null {
  return resolveClaudeCliHookOutcome(sessionId, hook).status
}

/**
 * Drop a session's sub-agent bookkeeping without touching its published-status
 * dedup. Called on a fresh turn (UserPromptSubmit) and from the PTY interrupt
 * mirror: an Escape/Ctrl+C kills any in-flight sub-agent, and Claude Code fires no
 * Stop for an interrupt, so the counter would stay >0 and defer the NEXT genuine
 * Stop of that turn. Clearing it also makes the killed sub-agent's trailing
 * SubagentStop untracked → status-less (see resolveClaudeCliHookOutcome), so it
 * cannot pull the interrupted ticket back to In Progress.
 */
export function resetSubagentTracking(sessionId: string): void {
  subagentDepthBySession.delete(sessionId)
  stopDeferredBySession.delete(sessionId)
}

function extractPlanText(hook: ParsedClaudeHook): string | undefined {
  return typeof hook.tool_input?.plan === 'string' ? hook.tool_input.plan : undefined
}

function buildStatusMetadata(
  hook: ParsedClaudeHook,
  hookPath: string
): NonNullable<ClaudeCliStatusPayload['metadata']> {
  const metadata: NonNullable<ClaudeCliStatusPayload['metadata']> = {
    hookEventName: hook.hook_event_name,
    hookPath
  }

  if (hook.tool_name) {
    metadata.toolName = hook.tool_name
  }

  const plan = extractPlanText(hook)
  if (plan !== undefined) {
    metadata.plan = plan
  }

  return metadata
}

export function publishClaudeCliStatus(payload: ClaudeCliStatusPayload): void {
  if (lastStatusBySession.get(payload.sessionId) === payload.status) {
    return
  }

  lastStatusBySession.set(payload.sessionId, payload.status)
  for (const subscriber of statusSubscribers) {
    subscriber(payload)
  }
  void import('../desktop/backend-event-publisher')
    .then(({ publishDesktopBackendEvent }) =>
      publishDesktopBackendEvent('claude-cli:status', payload)
    )
    .catch(() => undefined)
}

/**
 * Read the most recently published live status for a Claude CLI session, or
 * undefined if none has been published in this process. Used to gate actions
 * (e.g. teleport) on whether the session is actively running vs idle/stopped.
 */
export function getLastClaudeCliStatus(sessionId: string): SessionStatusType | undefined {
  return lastStatusBySession.get(sessionId)
}

/**
 * Drop a session's last-published status. Call from the PTY exit / destroy
 * teardown paths so the dedup map does not grow for the lifetime of the app and
 * a session re-created with the same id starts with fresh dedup state (otherwise
 * a stale 'completed' would swallow the restarted session's first status).
 */
export function clearClaudeCliStatus(sessionId: string): void {
  lastStatusBySession.delete(sessionId)
  subagentDepthBySession.delete(sessionId)
  stopDeferredBySession.delete(sessionId)
}

export function subscribeClaudeCliStatus(
  subscriber: (payload: ClaudeCliStatusPayload) => void
): () => void {
  statusSubscribers.add(subscriber)
  return () => {
    statusSubscribers.delete(subscriber)
  }
}

function parseHookPath(url: string | undefined): { sessionId: string; hookPath: string } | null {
  if (!url) return null

  try {
    const parsed = new URL(url, `http://${host}`)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 3 || segments[0] !== 'hook') return null

    return {
      sessionId: decodeURIComponent(segments[1]),
      hookPath: segments[2]
    }
  } catch {
    return null
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''

    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function handleHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const remoteAddress = req.socket.remoteAddress
  if (remoteAddress !== host) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }

  // Read+parse the body before responding so a registered transport relay
  // (Telegram/Discord) can mirror the hook stream. Interactive prompts —
  // AskUserQuestion / ExitPlanMode — render in the native terminal; the response
  // is never held open. The status publish below drives the in-app badge and
  // plan-ready card.
  const route = parseHookPath(req.url)
  let owned = false
  try {
    const rawBody = await readRequestBody(req)
    const body = JSON.parse(rawBody || '{}') as ParsedClaudeHook
    // MessageDisplay fires per streamed text chunk — accept + ack it (so the CLI
    // sees the hook it registered) but do NO further work: it maps to no session
    // status and carries no unique transcript value, and running the status /
    // telemetry / transport path per chunk would hammer this server.
    if (route && body.hook_event_name !== 'MessageDisplay') {
      const outcome = resolveClaudeCliHookOutcome(route.sessionId, body)
      if (outcome.status) {
        const metadata = buildStatusMetadata(body, route.hookPath)
        if (outcome.reportAs) {
          // A deferred main-turn stop resolved by this SubagentStop — report it as
          // the stop it actually was (see ClaudeCliHookOutcome) so the renderer's
          // StopFailure → Human Require and plan-mode → plan_ready routing fire.
          metadata.hookEventName = outcome.reportAs
          delete metadata.toolName
        }
        publishClaudeCliStatus({
          sessionId: route.sessionId,
          status: outcome.status,
          metadata
        })
      }
      void handleClaudeCliHiveTelemetryHook(route.sessionId, body)
      // First user prompt of this CLI session → tell the renderer so it can
      // auto-create a kanban ticket (if the setting is on). Fires for prompts
      // typed straight into the terminal as well as composer/handoff prompts.
      if (
        body.hook_event_name === 'UserPromptSubmit' &&
        typeof body.prompt === 'string' &&
        body.prompt.trim().length > 0 &&
        !firstPromptAnnounced.has(route.sessionId)
      ) {
        firstPromptAnnounced.add(route.sessionId)
        void publishDesktopBackendEvent(OPENCODE_STREAM_CHANNEL, {
          type: 'claude-cli.first-prompt-detected',
          sessionId: route.sessionId,
          data: { promptText: body.prompt }
        })
      }
      // Feed the hook to any registered transport relay so it can mirror the
      // transcript (busy/idle/assistant text). It never takes ownership of the
      // response — `routeHook` always returns false now that nothing is held.
      owned = cliHookTransportRouter.routeHook(route.sessionId, body, res)
    }
  } catch (error) {
    log.warn('Failed to parse Claude hook payload', {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  if (!owned && !res.writableEnded) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  }
}

export async function getClaudeHookServer(): Promise<{ port: number }> {
  if (server && boundPort !== null) {
    return { port: boundPort }
  }

  if (startingPromise) {
    return startingPromise
  }

  server = http.createServer((req, res) => {
    void handleHook(req, res)
  })

  // Hooks respond immediately (nothing is held), but keep Node's own request/
  // socket timeouts disabled so a slow client write can't drop a hook mid-flight.
  // The per-hook `timeout` in the injected settings remains the real upper bound.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.timeout = 0

  startingPromise = (async () => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server?.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server?.off('error', onError)
        resolve()
      }

      server?.once('error', onError)
      server?.once('listening', onListening)
      server?.listen(0, host)
    })

    const address = server?.address()
    if (!address || typeof address === 'string') {
      throw new Error('Claude hook server failed to bind a TCP port')
    }

    boundPort = address.port
    log.info(`ClaudeHookServer listening on http://${host}:${boundPort}`)
    return { port: boundPort }
  })()

  try {
    return await startingPromise
  } catch (error) {
    server = null
    boundPort = null
    throw error
  } finally {
    startingPromise = null
  }
}

export async function closeClaudeHookServer(): Promise<void> {
  // Clear transport-relay registrations at shutdown. Nothing holds hook sockets
  // open anymore, so this no longer needs to unblock pending responses.
  cliHookTransportRouter.cancelAll()

  if (!server) {
    boundPort = null
    startingPromise = null
    lastStatusBySession.clear()
    statusSubscribers.clear()
    subagentDepthBySession.clear()
    stopDeferredBySession.clear()
    return
  }

  const closingServer = server
  server = null

  await new Promise<void>((resolve, reject) => {
    closingServer.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })

  log.info('ClaudeHookServer closed')
  boundPort = null
  startingPromise = null
  lastStatusBySession.clear()
  statusSubscribers.clear()
  subagentDepthBySession.clear()
  stopDeferredBySession.clear()
}
