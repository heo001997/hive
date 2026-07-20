// Typed wrappers over the Hive RPC methods this app calls.
//
// Method names and param shapes below were verified against the server router
// in `src/server/rpc/domains/*.ts` (db-ops, opencode-ops, git-ops) and match
// how the shipped `hive` CLI (`resources/cli/hive.mjs`) invokes them. The
// custom envelope (`{ id, method, params }` -> `{ ok, value | error }`) and the
// `opencode:stream` subscription channel are handled inside `@hive/client`;
// here we just name methods and type their inputs/outputs.

import type { HiveClient } from '@hive/client'

// ── Domain record shapes (subset used by the UI) ────────────────────────────
// Mirrors src/shared/types/{project,worktree,session}.ts.

export interface Project {
  readonly id: string
  readonly name: string
  readonly path: string
}

export interface Worktree {
  readonly id: string
  readonly project_id: string
  readonly name: string
  readonly branch_name: string
  readonly path: string
  readonly status: 'active' | 'archived'
}

export type AgentSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'

export interface Session {
  readonly id: string
  readonly worktree_id: string | null
  readonly project_id: string
  readonly name: string | null
  readonly status: 'active' | 'completed' | 'error'
  readonly opencode_session_id: string | null
  readonly agent_sdk: AgentSdk
  readonly mode: 'build' | 'plan'
  readonly created_at: string
  readonly updated_at: string
}

// ── opencode-ops result shapes ──────────────────────────────────────────────

export interface OpenCodeConnectResult {
  readonly success: boolean
  readonly sessionId?: string
  readonly error?: string
}

export interface OpenCodeGetMessagesResult {
  readonly success: boolean
  readonly messages: unknown[]
  readonly error?: string
}

export interface OpenCodeSessionInfoResult {
  readonly success: boolean
  readonly revertMessageID?: string | null
  readonly revertDiff?: string | null
  readonly error?: string
}

export interface OpenCodePermissionListResult {
  readonly success: boolean
  readonly permissions: unknown[]
  readonly error?: string
}

export interface OpenCodeSimpleResult {
  readonly success: boolean
  readonly error?: string
}

// The `opencode:stream` payload, from src/shared/types/opencode.ts
// (`OpenCodeStreamEvent`). `sessionId` is the HIVE session id, so a subscriber
// filters on it to isolate one session's deltas.
export interface OpenCodeStreamEvent {
  readonly type: string
  readonly sessionId: string
  readonly data: unknown
}

export const OPENCODE_STREAM_CHANNEL = 'opencode:stream'

// ── git-ops result shapes ───────────────────────────────────────────────────

export interface GitDiffStatFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
}

export interface GitDiffStatResult {
  readonly success: boolean
  readonly files?: GitDiffStatFile[]
  readonly error?: string
}

export interface GitDiffResult {
  readonly success: boolean
  readonly diff?: string
  readonly fileName?: string
  readonly error?: string
}

// ── db: projects / worktrees / sessions ─────────────────────────────────────

export function listProjects(client: HiveClient): Promise<Project[]> {
  return client.request<Project[]>('db.project.getAll', {})
}

export function listWorktrees(client: HiveClient, projectId: string): Promise<Worktree[]> {
  return client.request<Worktree[]>('db.worktree.getByProject', { projectId })
}

export function getWorktree(client: HiveClient, id: string): Promise<Worktree | null> {
  return client.request<Worktree | null>('db.worktree.get', { id })
}

export function listSessions(client: HiveClient, worktreeId: string): Promise<Session[]> {
  return client.request<Session[]>('db.session.getByWorktree', { worktreeId })
}

export function getSession(client: HiveClient, id: string): Promise<Session | null> {
  return client.request<Session | null>('db.session.get', { id })
}

// ── opencode: connect / prompt / messages / info ────────────────────────────

export function connectSession(
  client: HiveClient,
  worktreePath: string,
  hiveSessionId: string
): Promise<OpenCodeConnectResult> {
  return client.request<OpenCodeConnectResult>('opencodeOps.connect', {
    worktreePath,
    hiveSessionId
  })
}

export function promptSession(
  client: HiveClient,
  worktreePath: string,
  opencodeSessionId: string,
  messageOrParts: string
): Promise<OpenCodeSimpleResult> {
  return client.request<OpenCodeSimpleResult>('opencodeOps.prompt', {
    worktreePath,
    opencodeSessionId,
    messageOrParts
  })
}

export function getMessages(
  client: HiveClient,
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeGetMessagesResult> {
  return client.request<OpenCodeGetMessagesResult>('opencodeOps.getMessages', {
    worktreePath,
    opencodeSessionId
  })
}

export function sessionInfo(
  client: HiveClient,
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeSessionInfoResult> {
  return client.request<OpenCodeSessionInfoResult>('opencodeOps.sessionInfo', {
    worktreePath,
    opencodeSessionId
  })
}

// ── opencode: approve / answer-needs-input actions ──────────────────────────

/** Approve a pending plan (plan-mode gate). */
export function planApprove(
  client: HiveClient,
  worktreePath: string,
  hiveSessionId: string,
  requestId?: string
): Promise<OpenCodeSimpleResult> {
  return client.request<OpenCodeSimpleResult>('opencodeOps.planApprove', {
    worktreePath,
    hiveSessionId,
    ...(requestId ? { requestId } : {})
  })
}

/** Reject a pending plan with feedback. */
export function planReject(
  client: HiveClient,
  worktreePath: string,
  hiveSessionId: string,
  feedback: string,
  requestId?: string
): Promise<OpenCodeSimpleResult> {
  return client.request<OpenCodeSimpleResult>('opencodeOps.planReject', {
    worktreePath,
    hiveSessionId,
    feedback,
    ...(requestId ? { requestId } : {})
  })
}

/** List the currently-pending tool/command permission requests. */
export function permissionList(
  client: HiveClient,
  worktreePath: string
): Promise<OpenCodePermissionListResult> {
  return client.request<OpenCodePermissionListResult>('opencodeOps.permissionList', {
    worktreePath
  })
}

/** Reply to a pending permission request: allow once / always, or reject. */
export function permissionReply(
  client: HiveClient,
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  worktreePath: string,
  message?: string
): Promise<OpenCodeSimpleResult> {
  return client.request<OpenCodeSimpleResult>('opencodeOps.permissionReply', {
    requestId,
    reply,
    worktreePath,
    ...(message ? { message } : {})
  })
}

/**
 * Answer an AskUserQuestion-style prompt. `answers` is an array (one entry per
 * question) of the selected option label arrays, matching the server's
 * `answers: string[][]` schema.
 */
export function questionReply(
  client: HiveClient,
  requestId: string,
  answers: string[][],
  worktreePath?: string
): Promise<OpenCodeSimpleResult> {
  return client.request<OpenCodeSimpleResult>('opencodeOps.questionReply', {
    requestId,
    answers,
    ...(worktreePath ? { worktreePath } : {})
  })
}

/** Reject / dismiss a pending question. */
export function questionReject(
  client: HiveClient,
  requestId: string,
  worktreePath?: string
): Promise<OpenCodeSimpleResult> {
  return client.request<OpenCodeSimpleResult>('opencodeOps.questionReject', {
    requestId,
    ...(worktreePath ? { worktreePath } : {})
  })
}

// ── git: diff stat + per-file diff ──────────────────────────────────────────

export function getDiffStat(client: HiveClient, worktreePath: string): Promise<GitDiffStatResult> {
  return client.request<GitDiffStatResult>('gitOps.getDiffStat', { worktreePath })
}

export function getDiff(
  client: HiveClient,
  worktreePath: string,
  filePath: string,
  opts?: { staged?: boolean; isUntracked?: boolean }
): Promise<GitDiffResult> {
  return client.request<GitDiffResult>('gitOps.getDiff', {
    worktreePath,
    filePath,
    staged: Boolean(opts?.staged),
    isUntracked: Boolean(opts?.isUntracked)
  })
}

// ── push registration (backend agent implements `push.register`) ────────────

// Matches the backend's strict `push.register` schema: `{ token, platform }`
// only (platform ∈ ios | android | web). No extra fields — the server rejects
// unknown keys.
export interface PushRegisterParams {
  readonly token: string
  readonly platform: 'ios' | 'android' | 'web'
}

export function registerPush(
  client: HiveClient,
  params: PushRegisterParams
): Promise<unknown> {
  return client.request('push.register', params)
}

// ── stream subscription ─────────────────────────────────────────────────────

/**
 * Subscribe to `opencode:stream` and invoke `onEvent` only for events whose
 * `sessionId` matches the given HIVE session id. Returns an unsubscribe fn.
 */
export function subscribeSessionStream(
  client: HiveClient,
  hiveSessionId: string,
  onEvent: (event: OpenCodeStreamEvent) => void
): () => void {
  // The transport delivers the full ServerEvent envelope `{ channel, payload }`;
  // the OpenCodeStreamEvent is carried in `payload`.
  return client.subscribe(OPENCODE_STREAM_CHANNEL, (serverEvent) => {
    const event = serverEvent.payload as OpenCodeStreamEvent | null
    if (event && typeof event === 'object' && event.sessionId === hiveSessionId) {
      onEvent(event)
    }
  })
}

/** Best-effort readable text from an arbitrary SDK stream/message payload. */
export function extractText(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'string') return data
  if (typeof data !== 'object') return String(data)
  const d = data as Record<string, unknown>
  const part = d.part as Record<string, unknown> | string | undefined
  const probe =
    (typeof part === 'object' && part && typeof part.text === 'string' ? part.text : undefined) ??
    (typeof d.text === 'string' ? d.text : undefined) ??
    (typeof d.delta === 'string' ? d.delta : undefined) ??
    (typeof d.message === 'string' ? d.message : undefined) ??
    (typeof part === 'string' ? part : undefined)
  if (typeof probe === 'string') return probe
  const json = JSON.stringify(data)
  return json.length > 600 ? `${json.slice(0, 600)}…` : json
}
