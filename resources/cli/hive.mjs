#!/usr/bin/env node
// hive — orchestrate a running Hive desktop app from the terminal: worktrees,
// agent sessions, git, and projects, over the app's RPC WebSocket. Sibling of
// `hive-ticket.mjs` and built the same way: it lives in the repo
// (`resources/cli/`), rides along in packaged builds (electron-builder
// `extraResources` → `process.resourcesPath/cli/`), and is intentionally
// DEPENDENCY-FREE — it uses Node's built-in global `WebSocket` (Node ≥ 22), so it
// runs as a single file with no `node_modules` next to it, from any cwd.
//
// The discovery + auth + instance-selection + RPC transport are copied verbatim
// from hive-ticket.mjs (the canonical shipped pattern). See that file's header
// for the full wire-protocol notes. In brief:
//
//   1. Discover EVERY live backend: GET /.well-known/hive/environment across
//      ports [3773..3873] in parallel; each live one returns its identity.
//   2. Select the RIGHT instance deterministically (--port / HIVE_PORT /
//      --instance / context auto-match / sole-instance). Prod refused implicitly.
//   3. Authenticate: POST /api/auth/bootstrap { bootstrapToken } → accessToken;
//      POST /api/auth/ws-token (Bearer accessToken) → webSocketToken; connect
//      ws://host:port/ws?token=…. Falls back to token-less when auth is off.
//   4. RPC envelope (custom, NOT JSON-RPC 2.0):
//        request:  { id, method, params }
//        response: { id, ok: true, value } | { id, ok: false, error }
//      Server→client events (from `subscribe`) arrive as { channel, payload }
//      with no `id`, so the request matcher ignores them.
//
// Every RPC method invoked below was verified to exist in src/server/rpc
// (router.ts + domains/{worktree,opencode,git,db}-ops.ts) against its Zod schema.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST = process.env.HIVE_HOST || '127.0.0.1'
const PORT_START = 3773
const PORT_END = 3873
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Channel the app publishes agent session stream deltas on (src/shared/opencode-events.ts).
const OPENCODE_STREAM_CHANNEL = 'opencode:stream'

// --sdk aliases → the agent_sdk enum the server accepts
// (['opencode','claude-code','claude-code-cli','codex','terminal']).
const SDK_ALIASES = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  'claude-cli': 'claude-code-cli',
  'claude-code-cli': 'claude-code-cli',
  codex: 'codex',
  opencode: 'opencode',
  terminal: 'terminal'
}
const VALID_SDKS = ['opencode', 'claude-code', 'claude-code-cli', 'codex', 'terminal']

export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i += 1
      }
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

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

// Scan the whole desktop port range IN PARALLEL and return every live Hive
// backend with its identity. Node's fetch sends no Origin header, so the server
// includes the identity fields for us.
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

export function describeInstance(i) {
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

export function isContextMatch(i, ctx) {
  if (i.dataDir && pathEq(i.dataDir, ctx.dataDir)) return true
  if (i.repoRoot && ctx.gitToplevel && pathEq(i.repoRoot, ctx.gitToplevel)) return true
  if (i.repoRoot && isUnder(ctx.cwd, i.repoRoot)) return true
  return false
}

// Block accidental targeting of the production board implicitly: a prod instance
// must be chosen explicitly (--instance / --port), never via auto-match/sole.
function guardImplicit(instance, all, onRefuse) {
  if (instance.instanceKind === 'production') {
    onRefuse(
      'Refusing to target the PRODUCTION Hive implicitly (safety guard).\n' +
        `Confirm explicitly with  --instance production  (or  --port ${instance.port}).\n\n` +
        'Running instances:\n' +
        listBlock(all)
    )
  }
  return instance
}

export function selectInstance(instances, ctx, onFail = die) {
  if (ctx.wantPort != null) {
    const m = instances.find((i) => i.port === ctx.wantPort)
    if (!m) {
      onFail(`No live Hive on port ${ctx.wantPort}. Running instances:\n` + listBlock(instances))
    }
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
    if (matches.length === 0) {
      onFail(`No Hive instance matches "${ctx.wantInstance}". Running instances:\n` + listBlock(instances))
    }
    onFail(`"${ctx.wantInstance}" is ambiguous:\n` + listBlock(matches))
  }

  const auto = instances.filter((i) => isContextMatch(i, ctx))
  if (auto.length === 1) return guardImplicit(auto[0], instances, onFail)

  if (instances.length === 1) return guardImplicit(instances[0], instances, onFail)

  onFail(
    'Multiple Hive instances are running — choose one with  --instance <name|kind>  or  --port <n>:\n' +
      listBlock(instances)
  )
}

// Find the bootstrap token for the SELECTED instance, most robust source first.
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
    // ps unavailable — give up; caller handles token-less path
  }

  return null
}

async function getWebSocketToken(instance) {
  const bootstrapToken = resolveBootstrapTokenFor(instance)
  if (!bootstrapToken) return null

  const boot = await fetchJson(`${instance.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken })
  })
  if (!boot.ok) {
    die(
      `Bootstrap rejected (HTTP ${boot.status}): ${boot.body?.error || 'Unauthorized'}.\n` +
        'The bootstrap token for this instance is stale or wrong. Restart Hive, or\n' +
        'export HIVE_DESKTOP_BOOTSTRAP_TOKEN to match the value it was launched with.'
    )
  }
  const accessToken = boot.body?.session?.accessToken
  if (!accessToken) die('Bootstrap response missing session.accessToken.')

  const wsTok = await fetchJson(`${instance.httpBaseUrl}/api/auth/ws-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` }
  })
  if (!wsTok.ok) die(`ws-token request failed (HTTP ${wsTok.status}).`)
  const token = wsTok.body?.webSocketToken?.token
  if (!token) die('ws-token response missing webSocketToken.token.')
  return token
}

// Mirrors WsTransport.createWebSocketUrl: append the WS token as a query param.
function connect(wsBaseUrl, token) {
  if (typeof WebSocket === 'undefined') {
    return Promise.reject(
      new Error(
        'This Node has no built-in WebSocket. Run with Node ≥ 22 (`node -v`), or install a newer Node.'
      )
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

// One round-trip on the RPC socket, matched by request id. Backstopped by a
// timeout, and rejects in-flight requests if the socket drops.
let nextId = 0
function rpc(ws, method, params, timeoutMs = 15000) {
  const id = `cli-${(nextId += 1)}`
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

// Subscribe to a server event channel (matches ws-server.ts: {type:'subscribe',
// channel}). Server pushes {channel, payload} frames with no id, so they never
// collide with rpc() replies. Returns an unsubscribe fn.
function subscribe(ws, channel, onEvent) {
  const onMessage = (event) => {
    let msg
    try {
      const raw =
        typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg && msg.channel === channel && 'payload' in msg) onEvent(msg.payload)
  }
  ws.addEventListener('message', onMessage)
  ws.send(JSON.stringify({ type: 'subscribe', channel }))
  return () => {
    ws.removeEventListener('message', onMessage)
    try {
      ws.send(JSON.stringify({ type: 'unsubscribe', channel }))
    } catch {
      // socket may already be closing — ignore
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared resolvers
// ─────────────────────────────────────────────────────────────────────────────

// Resolve the full project record (id, name, path, …). A UUID is looked up by id;
// otherwise matched by name against db.project.getAll (exact, then substring).
async function resolveProject(ws, wanted) {
  const projects = await rpc(ws, 'db.project.getAll', {})
  if (!Array.isArray(projects) || projects.length === 0) {
    die('No projects exist in Hive yet. Create one in the app first.')
  }
  if (wanted && UUID_RE.test(wanted)) {
    const byId = projects.find((p) => p.id === wanted)
    if (byId) return byId
    die(`No project with id ${wanted}.`)
  }
  if (!wanted || typeof wanted !== 'string') {
    if (projects.length === 1) return projects[0]
    die(
      'Multiple projects — specify one with --project <name|id>:\n' +
        projects.map((p) => `  - ${p.name}  (${p.id})`).join('\n')
    )
  }
  const lower = wanted.toLowerCase()
  const exact = projects.filter((p) => p.name?.toLowerCase() === lower)
  const matches = exact.length ? exact : projects.filter((p) => p.name?.toLowerCase().includes(lower))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    die(
      `No project matches "${wanted}". Available:\n` +
        projects.map((p) => `  - ${p.name}  (${p.id})`).join('\n')
    )
  }
  die(`"${wanted}" is ambiguous:\n` + matches.map((p) => `  - ${p.name}  (${p.id})`).join('\n'))
}

async function getProjectById(ws, id) {
  const project = await rpc(ws, 'db.project.get', { id })
  if (!project) die(`No project with id ${id}.`)
  return project
}

// Resolve a worktree record. A UUID goes straight to db.worktree.get; a name is
// matched within the given project (db.worktree.getByProject).
async function resolveWorktree(ws, projectId, value) {
  if (!value || value === true) die('A worktree id or name is required (--worktree <id|name>).')
  const v = String(value)
  if (UUID_RE.test(v)) {
    const wt = await rpc(ws, 'db.worktree.get', { id: v })
    if (!wt) die(`No worktree with id ${v}.`)
    return wt
  }
  if (!projectId) {
    die(`"${v}" is not a worktree id. Pass --project <name|id> to resolve a worktree by name.`)
  }
  const worktrees = await rpc(ws, 'db.worktree.getByProject', { projectId })
  const rows = Array.isArray(worktrees) ? worktrees : []
  const lower = v.toLowerCase()
  const exact = rows.filter((w) => w.name?.toLowerCase() === lower)
  const matches = exact.length ? exact : rows.filter((w) => w.name?.toLowerCase().includes(lower))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) die(`No worktree matches "${v}" in this project.`)
  die(`"${v}" is ambiguous:\n` + matches.map((w) => `  - ${w.name}  (${w.id})`).join('\n'))
}

function emit(flags, machine, humanLines) {
  if (flags.json) {
    console.log(JSON.stringify(machine, null, 2))
    return
  }
  const lines = Array.isArray(humanLines) ? humanLines : [humanLines]
  for (const l of lines) if (l != null) console.log(l)
}

function mapSdk(value) {
  if (!value || value === true) {
    die(`session start: --sdk is required. One of: ${Object.keys(SDK_ALIASES).join(', ')}.`)
  }
  const s = String(value).toLowerCase()
  const mapped = SDK_ALIASES[s] || s
  if (!VALID_SDKS.includes(mapped)) {
    die(`session start: unknown --sdk "${value}". One of: ${Object.keys(SDK_ALIASES).join(', ')}.`)
  }
  return mapped
}

// Best-effort readable snippet from an arbitrary SDK stream-event payload.
function eventText(data) {
  if (data == null) return ''
  if (typeof data === 'string') return data
  if (typeof data !== 'object') return String(data)
  const probe =
    data.part?.text ??
    data.text ??
    data.delta ??
    data.message ??
    (typeof data.part === 'string' ? data.part : undefined)
  if (typeof probe === 'string') return probe
  const json = JSON.stringify(data)
  return json.length > 400 ? `${json.slice(0, 400)}…` : json
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `hive — orchestrate a running Hive app over RPC (worktrees, sessions, git, projects).

  hive project list [--json]

  hive worktree list [--project <name|id>] [--include-archived] [--json]
  hive worktree create [--project <name|id>] [--json]
  hive worktree remove <worktreeId|name> [--project <name|id>] [--hard] [--json]
  hive worktree duplicate <worktreeId|name> [--project <name|id>] [--name <hint>] [--json]

  hive session start --sdk <claude|codex|opencode> --worktree <id|name>
                     [--project <name|id>] [--mode build|plan|super-plan] [--json]
  hive session prompt <hiveSessionId> "message text"
  hive session logs <hiveSessionId> [--follow] [--json]

  hive git status [--worktree-path <p> | --worktree <id|name> [--project <name|id>]] [--json]
  hive git diff   [--file <relpath> [--staged] [--untracked]]
                  [--worktree-path <p> | --worktree <id|name> [--project <name|id>]] [--json]

Target a specific Hive:  --instance <name|kind> | --port <n>
Global:  --json (machine output)   --help
Env (auto-injected when launched by Hive):  HIVE_PORT, HIVE_PROJECT_ID,
  HIVE_WORKTREE_ID, HIVE_DATA_DIR, HIVE_DESKTOP_BOOTSTRAP_TOKEN`

const DOMAINS = {
  project: new Set(['list']),
  worktree: new Set(['list', 'create', 'remove', 'duplicate']),
  session: new Set(['start', 'prompt', 'logs']),
  git: new Set(['status', 'diff'])
}

function wantedProject(flags) {
  return flags.project || process.env.HIVE_PROJECT_ID || null
}

// ── project ──────────────────────────────────────────────────────────────────
async function cmdProjectList(ws, flags) {
  const projects = await rpc(ws, 'db.project.getAll', {})
  const rows = Array.isArray(projects) ? projects : []
  emit(
    flags,
    rows,
    rows.length ? rows.map((p) => `${p.id}\t${p.name}\t${p.path}`) : '(no projects)'
  )
}

// ── worktree ─────────────────────────────────────────────────────────────────
async function cmdWorktreeList(ws, flags) {
  const project = await resolveProject(ws, wantedProject(flags))
  const worktrees = await rpc(ws, 'db.worktree.getByProject', { projectId: project.id })
  let rows = Array.isArray(worktrees) ? worktrees : []
  if (!flags['include-archived']) rows = rows.filter((w) => w.status !== 'archived')
  emit(
    flags,
    rows,
    rows.length
      ? rows.map((w) => `${w.id}\t${w.status}\t${w.branch_name}\t${w.path}`)
      : '(no worktrees)'
  )
}

async function cmdWorktreeCreate(ws, flags) {
  const project = await resolveProject(ws, wantedProject(flags))
  const result = await rpc(
    ws,
    'worktreeOps.create',
    { projectId: project.id, projectPath: project.path, projectName: project.name },
    60000
  )
  if (!result?.success) die(`worktree create failed: ${result?.error || 'unknown error'}`)
  const wt = result.worktree
  emit(flags, result, wt ? `Created worktree: ${wt.id} — ${wt.branch_name}  ${wt.path}` : 'Created.')
}

async function cmdWorktreeRemove(ws, flags, positional) {
  const value = positional[2] || flags.worktree || process.env.HIVE_WORKTREE_ID
  const worktree = await resolveWorktree(ws, (await maybeProjectId(ws, flags)), value)
  const project = await getProjectById(ws, worktree.project_id)
  // Default is a safe archive; --hard permanently deletes the worktree.
  const archive = !flags.hard
  const result = await rpc(
    ws,
    'worktreeOps.delete',
    {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      branchName: worktree.branch_name,
      projectPath: project.path,
      archive
    },
    60000
  )
  if (!result?.success) die(`worktree remove failed: ${result?.error || 'unknown error'}`)
  emit(flags, result, `${archive ? 'Archived' : 'Removed'} worktree: ${worktree.id} — ${worktree.branch_name}`)
}

async function cmdWorktreeDuplicate(ws, flags, positional) {
  const value = positional[2] || flags.worktree || process.env.HIVE_WORKTREE_ID
  const worktree = await resolveWorktree(ws, (await maybeProjectId(ws, flags)), value)
  const project = await getProjectById(ws, worktree.project_id)
  const params = {
    projectId: project.id,
    projectPath: project.path,
    projectName: project.name,
    sourceBranch: worktree.branch_name,
    sourceWorktreePath: worktree.path
  }
  if (flags.name && flags.name !== true) params.nameHint = String(flags.name)
  const result = await rpc(ws, 'worktreeOps.duplicate', params, 60000)
  if (!result?.success) die(`worktree duplicate failed: ${result?.error || 'unknown error'}`)
  const wt = result.worktree
  emit(
    flags,
    result,
    wt ? `Duplicated → ${wt.id} — ${wt.branch_name}  ${wt.path}` : 'Duplicated.'
  )
}

// Resolve a project id from flags ONLY when one was supplied (for by-name
// worktree lookups); returns null otherwise so a UUID lookup can proceed alone.
async function maybeProjectId(ws, flags) {
  const wanted = wantedProject(flags)
  if (!wanted) return null
  const project = await resolveProject(ws, wanted)
  return project.id
}

// ── session ──────────────────────────────────────────────────────────────────
async function cmdSessionStart(ws, flags) {
  const agentSdk = mapSdk(flags.sdk)
  const projectId = await maybeProjectId(ws, flags)
  const worktree = await resolveWorktree(
    ws,
    projectId,
    flags.worktree || process.env.HIVE_WORKTREE_ID
  )
  const createParams = {
    worktree_id: worktree.id,
    project_id: worktree.project_id,
    agent_sdk: agentSdk
  }
  if (flags.mode && flags.mode !== true) {
    const mode = String(flags.mode)
    if (!['build', 'plan', 'super-plan'].includes(mode)) {
      die(`session start: bad --mode "${mode}". One of: build, plan, super-plan.`)
    }
    createParams.mode = mode
  }
  const session = await rpc(ws, 'db.session.create', createParams)
  if (!session?.id) die('db.session.create returned no session id.')

  const connectRes = await rpc(
    ws,
    'opencodeOps.connect',
    { worktreePath: worktree.path, hiveSessionId: session.id },
    120000
  )
  if (!connectRes?.success || !connectRes?.sessionId) {
    die(`session connect failed: ${connectRes?.error || 'unknown error'}`)
  }
  const opencodeSessionId = connectRes.sessionId
  // Persist the opencode session id back onto the Hive session (mirrors the app).
  await rpc(ws, 'db.session.update', {
    id: session.id,
    data: { opencode_session_id: opencodeSessionId }
  })

  emit(
    flags,
    { hiveSessionId: session.id, opencodeSessionId, agentSdk, worktreeId: worktree.id },
    [
      `Started ${agentSdk} session`,
      `  hive session id:     ${session.id}`,
      `  opencode session id: ${opencodeSessionId}`,
      `  worktree:            ${worktree.branch_name}  ${worktree.path}`
    ]
  )
}

async function loadSessionTarget(ws, hiveSessionId) {
  if (!hiveSessionId || hiveSessionId === true) die('A hive session id is required.')
  const session = await rpc(ws, 'db.session.get', { id: String(hiveSessionId) })
  if (!session) die(`No session ${hiveSessionId}.`)
  if (!session.opencode_session_id) {
    die(`Session ${hiveSessionId} has no opencode session id (not started/connected yet).`)
  }
  if (!session.worktree_id) die(`Session ${hiveSessionId} has no worktree.`)
  const worktree = await rpc(ws, 'db.worktree.get', { id: session.worktree_id })
  if (!worktree) die(`Worktree ${session.worktree_id} not found.`)
  return { session, worktree, opencodeSessionId: session.opencode_session_id }
}

async function cmdSessionPrompt(ws, flags, positional) {
  const hiveSessionId = positional[2] || flags.session
  const message = positional[3] || flags.message
  if (!message || message === true) die('session prompt: a message is required.')
  const { worktree, opencodeSessionId } = await loadSessionTarget(ws, hiveSessionId)
  await rpc(
    ws,
    'opencodeOps.prompt',
    { worktreePath: worktree.path, opencodeSessionId, messageOrParts: String(message) },
    60000
  )
  emit(flags, { ok: true, opencodeSessionId }, `Prompt sent to ${hiveSessionId}.`)
}

async function cmdSessionLogs(ws, flags, positional) {
  const hiveSessionId = positional[2] || flags.session
  const { worktree, opencodeSessionId } = await loadSessionTarget(ws, hiveSessionId)

  if (flags.follow) {
    console.error(`→ following session ${hiveSessionId} (opencode ${opencodeSessionId}). Ctrl-C to stop.`)
    subscribe(ws, OPENCODE_STREAM_CHANNEL, (payload) => {
      if (!payload || payload.sessionId !== String(hiveSessionId)) return
      if (flags.json) {
        console.log(JSON.stringify(payload))
        return
      }
      const text = eventText(payload.data)
      console.log(text ? `[${payload.type}] ${text}` : `[${payload.type}]`)
    })
    // Block forever; the socket stays open until the process is interrupted.
    await new Promise(() => {})
    return
  }

  const res = await rpc(
    ws,
    'opencodeOps.getMessages',
    { worktreePath: worktree.path, opencodeSessionId },
    30000
  )
  if (!res?.success) die(`session logs failed: ${res?.error || 'unknown error'}`)
  const messages = Array.isArray(res.messages) ? res.messages : []
  if (flags.json) {
    console.log(JSON.stringify(messages, null, 2))
    return
  }
  if (messages.length === 0) {
    console.log('(no messages)')
    return
  }
  // Human view: one compact JSON line per message. Message shape is SDK-specific,
  // so structured rendering is left to --json.
  for (const m of messages) console.log(JSON.stringify(m))
}

// ── git ──────────────────────────────────────────────────────────────────────
async function resolveWorktreePath(ws, flags) {
  if (flags['worktree-path'] && flags['worktree-path'] !== true) {
    return String(flags['worktree-path'])
  }
  if (flags.worktree && flags.worktree !== true) {
    const projectId = await maybeProjectId(ws, flags)
    const worktree = await resolveWorktree(ws, projectId, flags.worktree)
    return worktree.path
  }
  return process.cwd()
}

async function cmdGitStatus(ws, flags) {
  const worktreePath = await resolveWorktreePath(ws, flags)
  const res = await rpc(ws, 'gitOps.getFileStatuses', { worktreePath })
  if (!res?.success) die(`git status failed: ${res?.error || 'unknown error'}`)
  const files = Array.isArray(res.files) ? res.files : []
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (files.length === 0) {
    console.log('(clean)')
    return
  }
  for (const f of files) {
    console.log(`${f.status}\t${f.staged ? 'staged  ' : 'unstaged'}\t${f.relativePath}`)
  }
}

async function cmdGitDiff(ws, flags) {
  const worktreePath = await resolveWorktreePath(ws, flags)

  if (flags.file && flags.file !== true) {
    const res = await rpc(ws, 'gitOps.getDiff', {
      worktreePath,
      filePath: String(flags.file),
      staged: Boolean(flags.staged),
      isUntracked: Boolean(flags.untracked)
    })
    if (!res?.success) die(`git diff failed: ${res?.error || 'unknown error'}`)
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }
    console.log(res.diff || '(no diff)')
    return
  }

  // No file → per-worktree diffstat overview.
  const res = await rpc(ws, 'gitOps.getDiffStat', { worktreePath })
  if (!res?.success) die(`git diff failed: ${res?.error || 'unknown error'}`)
  const files = Array.isArray(res.files) ? res.files : []
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (files.length === 0) {
    console.log('(no changes)')
    return
  }
  for (const f of files) {
    const stat = f.binary ? 'bin' : `+${f.additions} -${f.deletions}`
    console.log(`${stat}\t${f.path}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function dispatch(ws, domain, action, flags, positional) {
  switch (`${domain}.${action}`) {
    case 'project.list':
      return cmdProjectList(ws, flags)
    case 'worktree.list':
      return cmdWorktreeList(ws, flags)
    case 'worktree.create':
      return cmdWorktreeCreate(ws, flags)
    case 'worktree.remove':
      return cmdWorktreeRemove(ws, flags, positional)
    case 'worktree.duplicate':
      return cmdWorktreeDuplicate(ws, flags, positional)
    case 'session.start':
      return cmdSessionStart(ws, flags)
    case 'session.prompt':
      return cmdSessionPrompt(ws, flags, positional)
    case 'session.logs':
      return cmdSessionLogs(ws, flags, positional)
    case 'git.status':
      return cmdGitStatus(ws, flags)
    case 'git.diff':
      return cmdGitDiff(ws, flags)
    default:
      die(`Unknown command "${domain} ${action}". See --help.`)
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))

  if (flags.help || flags.h || positional.length === 0) {
    console.log(USAGE)
    return
  }

  const domain = positional[0]
  const action = positional[1]
  if (!DOMAINS[domain]) {
    die(`Unknown command "${domain}". One of: ${Object.keys(DOMAINS).join(', ')}. See --help.`)
  }
  if (!action || !DOMAINS[domain].has(action)) {
    die(
      `Unknown "${domain}" action "${action || ''}". One of: ` +
        `${[...DOMAINS[domain]].join(', ')}. See --help.`
    )
  }

  const instances = await discoverBackends()
  if (instances.length === 0) {
    die(
      `Cannot reach any Hive on ${HOST}:${PORT_START}-${PORT_END}. Is the app running?\n` +
        '(Override the host with HIVE_HOST if it listens elsewhere.)'
    )
  }

  const wantPort = flags.port
    ? Number(flags.port)
    : process.env.HIVE_PORT
      ? Number(process.env.HIVE_PORT)
      : null
  const instance = selectInstance(instances, {
    wantPort,
    wantInstance: flags.instance || process.env.HIVE_INSTANCE || null,
    cwd: process.cwd(),
    dataDir: selfDataDir(),
    gitToplevel: gitToplevel()
  })

  console.error(`→ ${describeInstance(instance)}`)

  const token = await getWebSocketToken(instance)
  if (!token && instance.hasDesktopBootstrapToken) {
    die(
      'This Hive requires auth but its bootstrap token could not be found.\n' +
        "Tried: $HIVE_DESKTOP_BOOTSTRAP_TOKEN, the instance's cli.json, and the\n" +
        "running app's argv (ps). For a signed/notarized app that hides its argv,\n" +
        'export the token explicitly and re-run:\n' +
        '  export HIVE_DESKTOP_BOOTSTRAP_TOKEN=<token Hive was launched with>'
    )
  }

  let ws
  try {
    ws = await connect(instance.wsBaseUrl, token)
  } catch (e) {
    die(`Cannot open RPC socket (${e.message}). Is Hive running and authorized?`)
  }

  try {
    await dispatch(ws, domain, action, flags, positional)
  } finally {
    // `session logs --follow` blocks forever above, so this only runs for the
    // one-shot commands — leaving the follow socket open until Ctrl-C.
    ws.close()
  }
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return import.meta.url === pathToFileURL(entry).href
  }
}
if (isDirectRun()) {
  main().catch((e) => die(e?.message || String(e)))
}
