#!/usr/bin/env node
// hive-mcp — a dependency-free Model Context Protocol (MCP) server that turns the
// running Hive desktop app into an MCP *provider*, so any external AI agent that
// speaks MCP (Claude Code, Claude Desktop, Cursor, …) can drive Hive: create and
// list worktrees, start/prompt/inspect agent sessions, and read git status.
//
// Design goals (mirror resources/cli/hive-ticket.mjs):
//   - ZERO npm dependencies. Single self-contained .mjs. Uses only Node built-ins
//     and the global `fetch` / `WebSocket` (Node ≥ 22), so it runs from any cwd
//     with no `node_modules` next to it and rides along in packaged builds.
//   - Talks to the SAME backend as hive-ticket: discover live Hive instances on
//     ports 3773..3873, select one deterministically, do the bootstrap → ws-token
//     handshake, then speak Hive's custom `{ id, method, params }` RPC envelope
//     over ws://…/ws. A minimal copy of that client is embedded below (no imports
//     of other project files — this is a standalone parallel stream).
//
// Transport: MCP stdio — newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout is
// RESERVED for JSON-RPC frames; ALL diagnostics go to stderr. We never call
// process.exit on an RPC failure — errors are returned to the MCP client instead.
//
// Methods implemented (spec-correct minimal surface):
//   initialize        -> { protocolVersion, serverInfo, capabilities: { tools: {} } }
//   notifications/*   -> accepted silently (no response, per JSON-RPC notifications)
//   tools/list        -> the curated, SAFE tool catalogue below
//   tools/call        -> connect to Hive, invoke the mapped RPC, return MCP text
//   ping              -> {}
//
// SAFE by construction: only read + create/prompt tools are exposed. Destructive
// Hive RPCs (worktreeOps.delete, db.*.delete, gitOps.discardChanges, …) are NOT
// mapped to any tool.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const HOST = process.env.HIVE_HOST || '127.0.0.1'
const PORT_START = 3773
const PORT_END = 3873
const SERVER_NAME = 'hive-mcp'
const SERVER_VERSION = '0.1.0'
// The newest MCP protocol revision we understand. If a client asks for a version
// we recognize as a string, we echo it back (max compatibility); otherwise we
// advertise this one.
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

// Diagnostics ONLY to stderr — stdout is the JSON-RPC channel.
function logErr(...args) {
  try {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n')
  } catch {
    // stderr gone — nothing we can safely do
  }
}

// A JSON-RPC-shaped error carrying a numeric code, so dispatch() can surface a
// proper `error` object rather than a generic internal error.
class McpError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedded Hive backend client (minimal copy of resources/cli/hive-ticket.mjs).
// Every function here THROWS on failure (never process.exit / console.log) so the
// MCP layer can translate a failure into a JSON-RPC / tool error.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJson(url, init, timeoutMs = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { raw: text }
    }
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(t)
  }
}

// Scan the whole desktop port range IN PARALLEL and return every live Hive backend
// with its identity. Node's fetch sends no Origin header, so the server includes
// the identity fields for us (they're withheld from browser callers).
async function discoverBackends() {
  const ports = []
  for (let p = PORT_START; p <= PORT_END; p += 1) ports.push(p)

  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const { ok, body } = await fetchJson(
          `http://${HOST}:${port}/.well-known/hive/environment`,
          {},
          400
        )
        if (ok && body && typeof body.wsBaseUrl === 'string') {
          return {
            host: body.host || HOST,
            port: body.port || port,
            httpBaseUrl: body.httpBaseUrl || `http://${HOST}:${port}`,
            wsBaseUrl: body.wsBaseUrl,
            hasDesktopBootstrapToken: Boolean(body.hasDesktopBootstrapToken),
            mode: body.mode,
            instanceKind: body.instanceKind,
            label: body.label,
            appVersion: body.appVersion,
            dataDir: body.dataDir,
            repoRoot: body.repoRoot,
            pid: body.pid,
            startedAt: body.startedAt
          }
        }
      } catch {
        // port not listening / not hive — ignore
      }
      return null
    })
  )
  return results.filter(Boolean)
}

function describeInstance(i) {
  const kind = i.instanceKind || i.mode || (i.hasDesktopBootstrapToken ? 'desktop' : 'server')
  const label = i.label || i.repoRoot || i.dataDir || '(unknown)'
  const ver = i.appVersion ? ` · v${i.appVersion}` : ''
  return `${label}  [${kind} · :${i.port}${ver}]`
}

function listBlock(list) {
  return list
    .map((i) => `  - ${describeInstance(i)}${i.repoRoot ? `\n      ${i.repoRoot}` : ''}`)
    .join('\n')
}

function pathEq(a, b) {
  try {
    return resolve(a) === resolve(b)
  } catch {
    return false
  }
}

function isUnder(child, parent) {
  try {
    const p = resolve(parent)
    const c = resolve(child)
    return c === p || c.startsWith(p + sep)
  } catch {
    return false
  }
}

function selfDataDir() {
  const d = process.env.HIVE_DATA_DIR?.trim()
  return resolve(d || join(homedir(), '.hive'))
}

function gitToplevel() {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim() || null
  } catch {
    return null
  }
}

function isContextMatch(i, ctx) {
  if (i.dataDir && pathEq(i.dataDir, ctx.dataDir)) return true
  if (i.repoRoot && ctx.gitToplevel && pathEq(i.repoRoot, ctx.gitToplevel)) return true
  if (i.repoRoot && isUnder(ctx.cwd, i.repoRoot)) return true
  return false
}

// A production instance must be chosen explicitly (--instance / --port); never via
// auto-match or sole-instance. `onFail` throws.
function guardImplicit(instance, all, onFail) {
  if (instance.instanceKind === 'production') {
    onFail(
      'Refusing to target the PRODUCTION Hive implicitly (safety guard).\n' +
        `Confirm explicitly with  HIVE_INSTANCE=production  (or  HIVE_PORT=${instance.port}).\n\n` +
        'Running instances:\n' +
        listBlock(all)
    )
  }
  return instance
}

// Deterministic instance pick. `onFail(message)` must not return (it throws).
function selectInstance(instances, ctx, onFail) {
  if (ctx.wantPort != null) {
    const m = instances.find((i) => i.port === ctx.wantPort)
    if (!m) onFail(`No live Hive on port ${ctx.wantPort}. Running instances:\n` + listBlock(instances))
    return m
  }

  if (ctx.wantInstance) {
    const q = String(ctx.wantInstance).toLowerCase()
    const matches = instances.filter(
      (i) =>
        (i.label || '').toLowerCase().includes(q) ||
        (i.instanceKind || '').toLowerCase() === q ||
        (i.repoRoot || '').toLowerCase().includes(q) ||
        (i.dataDir || '').toLowerCase().includes(q) ||
        String(i.port) === q
    )
    if (matches.length === 1) return matches[0]
    if (matches.length === 0)
      onFail(`No Hive instance matches "${ctx.wantInstance}". Running instances:\n` + listBlock(instances))
    onFail(`"${ctx.wantInstance}" is ambiguous:\n` + listBlock(matches))
  }

  const auto = instances.filter((i) => isContextMatch(i, ctx))
  if (auto.length === 1) return guardImplicit(auto[0], instances, onFail)

  if (instances.length === 1) return guardImplicit(instances[0], instances, onFail)

  onFail(
    'Multiple Hive instances are running — choose one with  HIVE_INSTANCE=<name|kind>  or  HIVE_PORT=<n>:\n' +
      listBlock(instances)
  )
}

// Find the bootstrap token for the SELECTED instance, most robust source first:
// explicit env → the instance's own cli.json → scrape the running app's argv.
function resolveBootstrapTokenFor(instance) {
  const fromEnv = process.env.HIVE_DESKTOP_BOOTSTRAP_TOKEN?.trim()
  if (fromEnv) return fromEnv

  try {
    const dir = instance.dataDir || selfDataDir()
    const file = join(dir, 'cli.json')
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      const tok = j?.bootstrapToken ? String(j.bootstrapToken).trim() : ''
      if (tok && (j.port == null || j.port === instance.port)) return tok
    }
  } catch {
    // unreadable / malformed — fall through to argv scrape
  }

  try {
    const ps = execSync('ps -axww -o command=', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    for (const m of ps.matchAll(/hive-local-environment-bootstrap=(\S+)/g)) {
      try {
        const obj = JSON.parse(decodeURIComponent(m[1]))
        let port = null
        if (typeof obj?.wsBaseUrl === 'string') port = Number(new URL(obj.wsBaseUrl).port)
        else if (typeof obj?.httpBaseUrl === 'string') port = Number(new URL(obj.httpBaseUrl).port)
        else if (obj?.port != null) port = Number(obj.port)
        const tok = obj?.bootstrapToken ? String(obj.bootstrapToken).trim() : ''
        if (tok && port === instance.port) return tok
      } catch {
        // bad blob — try the next
      }
    }
  } catch {
    // ps unavailable — give up; caller handles the token-less path
  }

  return null
}

// Exchange the selected instance's bootstrap token for a short-lived WS token.
// Returns null when no bootstrap token is discoverable (token-less / auth-off dev).
async function getWebSocketToken(instance) {
  const bootstrapToken = resolveBootstrapTokenFor(instance)
  if (!bootstrapToken) return null

  const boot = await fetchJson(`${instance.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken })
  })
  if (!boot.ok) {
    throw new Error(
      `Bootstrap rejected (HTTP ${boot.status}): ${boot.body?.error || 'Unauthorized'}. ` +
        'The bootstrap token for this instance is stale or wrong. Restart Hive, or set ' +
        'HIVE_DESKTOP_BOOTSTRAP_TOKEN to the value it was launched with.'
    )
  }
  const accessToken = boot.body?.session?.accessToken
  if (!accessToken) throw new Error('Bootstrap response missing session.accessToken.')

  const wsTok = await fetchJson(`${instance.httpBaseUrl}/api/auth/ws-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` }
  })
  if (!wsTok.ok) throw new Error(`ws-token request failed (HTTP ${wsTok.status}).`)
  const token = wsTok.body?.webSocketToken?.token
  if (!token) throw new Error('ws-token response missing webSocketToken.token.')
  return token
}

// Open the RPC socket. Uses Node's built-in global WebSocket (no `ws` package).
function connect(wsBaseUrl, token) {
  if (typeof WebSocket === 'undefined') {
    return Promise.reject(
      new Error('This Node has no built-in WebSocket. Run with Node ≥ 22 (`node -v`).')
    )
  }
  let url = wsBaseUrl
  if (token) {
    const u = new URL(wsBaseUrl)
    u.searchParams.set('token', token)
    url = u.toString()
  }
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const cleanup = () => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
    }
    const onOpen = () => {
      cleanup()
      resolvePromise(ws)
    }
    const onError = (ev) => {
      cleanup()
      reject(new Error(`WS upgrade rejected (${ev?.message || 'bad/expired token?'}).`))
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })
}

// One round-trip on the RPC socket, matched by request id. Custom envelope:
//   request:  { id, method, params }
//   response: { id, ok: true, value } | { id, ok: false, error: { code, message } }
let nextRpcId = 0
function rpc(ws, method, params, timeoutMs = 20000) {
  const id = `mcp-${(nextRpcId += 1)}`
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`RPC timeout: ${method} got no reply in ${timeoutMs}ms`))
    }, timeoutMs)
    const onClose = () => {
      cleanup()
      reject(new Error(`RPC socket closed before ${method} replied`))
    }
    const onError = (e) => {
      cleanup()
      reject(new Error(`RPC socket error during ${method}: ${e?.message || 'error'}`))
    }
    const onMessage = (event) => {
      let msg
      try {
        const raw =
          typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.id !== id) return // ignore events / other replies
      cleanup()
      if (msg.ok) resolvePromise(msg.value)
      else reject(new Error(`${msg.error?.code || 'RPC_ERROR'}: ${msg.error?.message || 'failed'}`))
    }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// Minimal argv flag parse (only --port / --instance are honored; env is preferred
// for a long-lived MCP server).
function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}
const ARG_FLAGS = parseFlags(process.argv.slice(2))

function buildCtx() {
  const wantPort = process.env.HIVE_PORT
    ? Number(process.env.HIVE_PORT)
    : ARG_FLAGS.port && ARG_FLAGS.port !== true
      ? Number(ARG_FLAGS.port)
      : null
  return {
    wantPort,
    wantInstance:
      (ARG_FLAGS.instance && ARG_FLAGS.instance !== true ? String(ARG_FLAGS.instance) : null) ||
      process.env.HIVE_INSTANCE ||
      null,
    cwd: process.cwd(),
    dataDir: selfDataDir(),
    gitToplevel: gitToplevel()
  }
}

// Discover → select → auth → connect, run `fn(call)` on the open socket, then
// close. `call(method, params, timeoutMs?)` performs one RPC round-trip; `fn` may
// issue several over the SAME socket (e.g. resolve a trusted project record, then
// create a worktree). One short-lived socket per tool call (matches hive-ticket's
// one-shot model): robust against stale sockets, and tool calls are infrequent.
// Throws a plain Error on any failure.
async function withHive(fn) {
  const instances = await discoverBackends()
  if (instances.length === 0) {
    throw new Error(
      `No Hive backend reachable on ${HOST}:${PORT_START}-${PORT_END}. Is the Hive app running? ` +
        '(Override the host with HIVE_HOST if it listens elsewhere.)'
    )
  }
  const instance = selectInstance(instances, buildCtx(), (m) => {
    throw new Error(m)
  })
  logErr(`→ ${describeInstance(instance)}`)

  const token = await getWebSocketToken(instance)
  if (!token && instance.hasDesktopBootstrapToken) {
    throw new Error(
      'This Hive requires auth but its bootstrap token could not be found. ' +
        'Set HIVE_DESKTOP_BOOTSTRAP_TOKEN to the value Hive was launched with.'
    )
  }

  const ws = await connect(instance.wsBaseUrl, token)
  try {
    return await fn((method, params, timeoutMs) => rpc(ws, method, params, timeoutMs))
  } finally {
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
}

// One-shot convenience: open a socket, do a single RPC, close.
async function callHive(method, params) {
  return withHive((call) => call(method, params))
}

// ─────────────────────────────────────────────────────────────────────────────
// Curated, SAFE tool catalogue. Each tool exposes a JSON-Schema `inputSchema` and
// EITHER a `toRpc(args)` (sync map of validated args → one REAL Hive RPC method +
// params) OR an async `invoke(args)` that drives Hive itself (used when a tool
// must consult the backend to build trusted params). Only the exact keys each
// server-side (strict) zod schema allows are forwarded.
//   hive_worktree_create -> worktreeOps.create        { projectId } → resolves the
//                           TRUSTED project record via db.project.getAll, then
//                           creates using that record's real path/name (a caller
//                           can never supply projectPath/projectName)
//   hive_worktree_list   -> db.worktree.getByProject  { projectId }
//   hive_session_start   -> opencodeOps.connect       { worktreePath, hiveSessionId }
//   hive_session_prompt  -> opencodeOps.prompt        { worktreePath, opencodeSessionId, messageOrParts, model? }
//   hive_session_status  -> opencodeOps.sessionInfo   { worktreePath, opencodeSessionId }
//   hive_git_status      -> gitOps.getFileStatuses    { worktreePath }
// Destructive RPCs (delete / discard) are intentionally NOT exposed.
// ─────────────────────────────────────────────────────────────────────────────

function requireStr(args, key, tool) {
  const v = args?.[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new McpError(-32602, `${tool}: required string argument "${key}" is missing.`)
  }
  return v
}

// Resolve a TRUSTED project record by id via db.project.getAll (mirrors
// resources/cli/hive.mjs resolveProject). We NEVER trust a caller-supplied path or
// name: the worktree base path is derived from this record only, so a caller can't
// smuggle a '../../..' segment past the worktree base dir. `call` is the RPC fn
// handed in by withHive. Throws a plain Error (→ tool-error content) if not found.
async function resolveProjectById(call, projectId) {
  const projects = await call('db.project.getAll', {})
  const rows = Array.isArray(projects) ? projects : []
  const project = rows.find((p) => p && p.id === projectId)
  if (!project) {
    throw new Error(
      `No Hive project with id "${projectId}". ` +
        `Known project ids: ${rows.map((p) => p?.id).filter(Boolean).join(', ') || '(none)'}.`
    )
  }
  return project
}

const TOOLS = [
  {
    name: 'hive_worktree_create',
    description:
      'Create a new git worktree (an isolated branch checkout) in a Hive project. ' +
      'Takes ONLY the Hive project id; the repository path and project name are ' +
      'resolved from the trusted project record server-side (they are never ' +
      'supplied by the caller). Returns the created worktree, including its id and ' +
      'filesystem path.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The Hive project id (uuid) to create the worktree in.'
        }
      },
      required: ['projectId'],
      additionalProperties: false
    },
    // Consults Hive: validates args (throws on bad input, before any network),
    // resolves the TRUSTED project record by id, and derives projectPath /
    // projectName from it — so a caller can never inject a path/name segment and
    // escape the worktree base directory (path-traversal guard).
    invoke: async (a) => {
      const projectId = requireStr(a, 'projectId', 'hive_worktree_create')
      return withHive(async (call) => {
        const project = await resolveProjectById(call, projectId)
        return call(
          'worktreeOps.create',
          {
            projectId: project.id,
            projectPath: project.path,
            projectName: project.name
          },
          60000
        )
      })
    }
  },
  {
    name: 'hive_worktree_list',
    description: 'List all worktrees belonging to a Hive project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The Hive project id (uuid) to list worktrees for.' }
      },
      required: ['projectId'],
      additionalProperties: false
    },
    toRpc: (a) => ({
      method: 'db.worktree.getByProject',
      params: { projectId: requireStr(a, 'projectId', 'hive_worktree_list') }
    })
  },
  {
    name: 'hive_session_start',
    description:
      'Start (connect) an agent session for a worktree. Boots the agent backend for ' +
      'the given worktree path and associates it with a Hive session id. Returns the ' +
      'connection result, including the opencodeSessionId used by the prompt/status tools.',
    inputSchema: {
      type: 'object',
      properties: {
        worktreePath: {
          type: 'string',
          description: 'Absolute path to the worktree directory the agent should run in.'
        },
        hiveSessionId: {
          type: 'string',
          description: 'The Hive session id to bind this agent connection to.'
        }
      },
      required: ['worktreePath', 'hiveSessionId'],
      additionalProperties: false
    },
    toRpc: (a) => ({
      method: 'opencodeOps.connect',
      params: {
        worktreePath: requireStr(a, 'worktreePath', 'hive_session_start'),
        hiveSessionId: requireStr(a, 'hiveSessionId', 'hive_session_start')
      }
    })
  },
  {
    name: 'hive_session_prompt',
    description:
      'Send a text prompt to a running agent session. Requires the worktree path and ' +
      'the opencodeSessionId returned by hive_session_start.',
    inputSchema: {
      type: 'object',
      properties: {
        worktreePath: { type: 'string', description: 'Absolute path to the worktree directory.' },
        opencodeSessionId: {
          type: 'string',
          description: 'The agent session id (from hive_session_start / hive_session_status).'
        },
        message: { type: 'string', description: 'The prompt text to send to the agent.' },
        model: {
          type: 'object',
          description: 'Optional model override.',
          properties: {
            providerID: { type: 'string' },
            modelID: { type: 'string' },
            variant: { type: 'string' }
          },
          required: ['providerID', 'modelID'],
          additionalProperties: false
        }
      },
      required: ['worktreePath', 'opencodeSessionId', 'message'],
      additionalProperties: false
    },
    toRpc: (a) => {
      const params = {
        worktreePath: requireStr(a, 'worktreePath', 'hive_session_prompt'),
        opencodeSessionId: requireStr(a, 'opencodeSessionId', 'hive_session_prompt'),
        messageOrParts: requireStr(a, 'message', 'hive_session_prompt')
      }
      if (a.model && typeof a.model === 'object') {
        const m = {}
        if (typeof a.model.providerID === 'string') m.providerID = a.model.providerID
        if (typeof a.model.modelID === 'string') m.modelID = a.model.modelID
        if (typeof a.model.variant === 'string') m.variant = a.model.variant
        if (m.providerID && m.modelID) params.model = m
      }
      return { method: 'opencodeOps.prompt', params }
    }
  },
  {
    name: 'hive_session_status',
    description:
      'Get the current status / info for a running agent session (its state, model, ' +
      'and metadata). Requires the worktree path and the opencodeSessionId.',
    inputSchema: {
      type: 'object',
      properties: {
        worktreePath: { type: 'string', description: 'Absolute path to the worktree directory.' },
        opencodeSessionId: { type: 'string', description: 'The agent session id.' }
      },
      required: ['worktreePath', 'opencodeSessionId'],
      additionalProperties: false
    },
    toRpc: (a) => ({
      method: 'opencodeOps.sessionInfo',
      params: {
        worktreePath: requireStr(a, 'worktreePath', 'hive_session_status'),
        opencodeSessionId: requireStr(a, 'opencodeSessionId', 'hive_session_status')
      }
    })
  },
  {
    name: 'hive_git_status',
    description:
      'Get the git working-tree status (staged / unstaged / untracked file changes) ' +
      'for a worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        worktreePath: {
          type: 'string',
          description: 'Absolute path to the worktree directory to inspect.'
        }
      },
      required: ['worktreePath'],
      additionalProperties: false
    },
    toRpc: (a) => ({
      method: 'gitOps.getFileStatuses',
      params: { worktreePath: requireStr(a, 'worktreePath', 'hive_git_status') }
    })
  }
]

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

// ─────────────────────────────────────────────────────────────────────────────
// MCP method dispatch
// ─────────────────────────────────────────────────────────────────────────────

function toolCatalogue() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}

async function handleToolsCall(params) {
  const name = params?.name
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) throw new McpError(-32602, `Unknown tool: ${String(name)}`)

  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}

  // Two tool shapes. `invoke(args)` drives Hive itself (may issue several RPCs);
  // `toRpc(args)` maps validated args to a single RPC run via callHive. In both,
  // an argument-validation failure throws McpError → it stays an invalid-params
  // protocol error; any other failure (unreachable Hive, RPC rejection, project
  // not found) becomes tool-error content (isError:true) the model can react to.
  let label = String(name)
  try {
    let value
    if (typeof tool.invoke === 'function') {
      value = await tool.invoke(args)
    } else {
      const mapped = tool.toRpc(args)
      label = mapped.method
      value = await callHive(mapped.method, mapped.params)
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return { content: [{ type: 'text', text: text ?? 'null' }] }
  } catch (e) {
    if (e instanceof McpError) throw e
    return {
      content: [{ type: 'text', text: `Error calling ${label}: ${e?.message || e}` }],
      isError: true
    }
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null
      return {
        protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} }
      }
    }
    case 'tools/list':
      return { tools: toolCatalogue() }
    case 'tools/call':
      return await handleToolsCall(params)
    case 'ping':
      return {}
    default:
      throw new McpError(-32601, `Method not found: ${method}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// stdio transport: newline-delimited JSON-RPC 2.0
// ─────────────────────────────────────────────────────────────────────────────

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch (e) {
    logErr('failed to write response:', e?.message)
  }
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function handleMessage(msg) {
  // A well-formed message must be an object with a string `method`. A JSON-RPC
  // request carries an `id` (string or number, not null); a notification omits it.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    if (msg && msg.id != null) send(errorResponse(msg.id, -32600, 'Invalid Request'))
    return
  }
  const isRequest = msg.id !== undefined && msg.id !== null

  // Notifications (e.g. notifications/initialized): no response, ever.
  if (!isRequest) return

  try {
    const result = await dispatch(msg.method, msg.params)
    send({ jsonrpc: '2.0', id: msg.id, result })
  } catch (e) {
    const code = e instanceof McpError ? e.code : -32603
    send(errorResponse(msg.id, code, e?.message || 'Internal error'))
  }
}

async function handleLine(line) {
  const text = line.trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    // Parse errors get a null id per JSON-RPC 2.0.
    send(errorResponse(null, -32700, 'Parse error'))
    return
  }
  if (Array.isArray(msg)) {
    for (const m of msg) await handleMessage(m)
  } else {
    await handleMessage(msg)
  }
}

function main() {
  logErr(`${SERVER_NAME} v${SERVER_VERSION} — MCP stdio server for Hive (Node ${process.version})`)
  let buffer = ''
  // Process each line CONCURRENTLY — do NOT chain them. A slow/hung tools/call
  // must not block subsequent requests (ping/initialize/other tools). JSON-RPC
  // responses are matched by id and need not be ordered, and send() writes each
  // frame atomically (one write). We track in-flight handlers only so shutdown can
  // wait for them to finish before exiting.
  const inFlight = new Set()
  const spawn = (line) => {
    const p = handleLine(line)
      .catch((e) => logErr('line handler error:', e?.message))
      .finally(() => inFlight.delete(p))
    inFlight.add(p)
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      spawn(line)
    }
  })
  process.stdin.on('end', () => {
    // Flush any trailing line without a newline, then wait for all in-flight
    // handlers to settle (so their responses are written) before exiting.
    if (buffer.trim()) spawn(buffer)
    buffer = ''
    Promise.allSettled([...inFlight]).finally(() => process.exit(0))
  })
  process.stdin.on('error', (e) => logErr('stdin error:', e?.message))
}

main()
