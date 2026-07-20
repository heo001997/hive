#!/usr/bin/env node
// hive-ticket — create/read/update/delete Hive kanban tickets from the terminal
// over the running Hive app's RPC WebSocket. This is the canonical, shipped copy:
// it lives in the repo (`resources/cli/`), rides along in packaged builds
// (electron-builder `extraResources` → `process.resourcesPath/cli/`), and is the
// entry the desktop app injects as `$HIVE_TICKET_CLI` into every agent it spawns
// (see src/main/services/hive-cli-connection.ts). It is intentionally
// DEPENDENCY-FREE — it uses Node's built-in global `WebSocket` (Node ≥ 22), so it
// runs as a single file with no `node_modules` next to it, from any cwd.
//
// Wire protocol — verified against src/server (NOT plain JSON-RPC 2.0):
//
//   1. Discover EVERY live backend. The desktop app picks the first free port in
//      [3773..3873], and several Hive instances run at once (production, a
//      `pnpm dev` build, one per worktree). GET /.well-known/hive/environment on
//      all candidate ports in parallel; each live one returns its identity
//      (mode, instanceKind, label, dataDir, repoRoot, appVersion, port, …).
//      Identity fields are returned only to non-browser callers (no Origin
//      header), so this script sees them while a web page would not.
//
//   2. Select the RIGHT instance deterministically (never guess):
//        --port / HIVE_PORT            -> exact port
//        --instance / HIVE_INSTANCE    -> match label/kind/repoRoot/dataDir
//        context auto-match            -> the instance whose repoRoot/dataDir
//                                         matches this shell (the Hive for the
//                                         repo you're in)
//        exactly one running           -> it
//        otherwise                     -> list them and stop
//      A production instance is refused unless selected explicitly (safety).
//
//   3. Authenticate. Desktop mode ALWAYS sets HIVE_SERVER_REQUIRE_AUTH=true, so a
//      token-less WS upgrade is rejected. The handshake:
//        POST /api/auth/bootstrap { bootstrapToken } -> { session: { accessToken } }
//        POST /api/auth/ws-token  (Authorization: Bearer <accessToken>)
//                                 -> { webSocketToken: { token } }   (60s TTL)
//        connect ws://host:port/ws?token=<token>
//      The bootstrap token for the SELECTED instance is found from the most robust
//      source available (see resolveBootstrapTokenFor). A dev server started with
//      HIVE_SERVER_REQUIRE_AUTH=false accepts a token-less connection — we fall
//      back to that automatically when no bootstrap token is available.
//
//   4. RPC envelope is custom, NOT JSON-RPC 2.0:
//        request:  { id, method, params }                 // id is a non-empty string
//        response: { id, ok: true, value }
//                | { id, ok: false, error: { code, message } }
//      Methods used: db.project.getAll, kanban.ticket.{create,createBatch,get,
//        getByProject,update,move,delete}, kanban.dependency.{add,remove}.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST = process.env.HIVE_HOST || '127.0.0.1'
const PORT_START = 3773
const PORT_END = 3873
export const COLUMNS = ['todo', 'in_progress', 'review', 'done']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
// backend with its identity. (We can't early-return on the first responder:
// several instances run at once and the first is arbitrary.) Node's fetch sends
// no Origin header, so the server includes the identity fields for us.
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
            // Identity (present only from a recent Hive; undefined against older builds):
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

// This shell's data dir (matches a worktree's HIVE_DATA_DIR when set).
function selfDataDir() {
  const d = process.env.HIVE_DATA_DIR?.trim()
  return resolve(d || join(homedir(), '.hive'))
}

// This shell's git toplevel, if any — used to match the instance bound to the
// same repo/worktree.
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

// Is this instance the one bound to the repo/worktree this shell is in?
export function isContextMatch(i, ctx) {
  if (i.dataDir && pathEq(i.dataDir, ctx.dataDir)) return true
  if (i.repoRoot && ctx.gitToplevel && pathEq(i.repoRoot, ctx.gitToplevel)) return true
  if (i.repoRoot && isUnder(ctx.cwd, i.repoRoot)) return true
  return false
}

// Block accidental writes to the production board: a prod instance must be chosen
// explicitly (--instance / --port), never via auto-match or sole-instance.
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

// Deterministic instance pick. `onFail(message)` is invoked (and must not return)
// when selection can't proceed — the CLI passes `die`; tests pass a thrower.
export function selectInstance(instances, ctx, onFail = die) {
  // 1. Explicit port wins outright (no guard — the user named it).
  if (ctx.wantPort != null) {
    const m = instances.find((i) => i.port === ctx.wantPort)
    if (!m) {
      onFail(`No live Hive on port ${ctx.wantPort}. Running instances:\n` + listBlock(instances))
    }
    return m
  }

  // 2. Explicit instance string — match label / kind / repoRoot / dataDir.
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

  // 3. Context auto-match: the Hive for the repo/worktree this shell is in.
  const auto = instances.filter((i) => isContextMatch(i, ctx))
  if (auto.length === 1) return guardImplicit(auto[0], instances, onFail)

  // 4. Exactly one instance alive.
  if (instances.length === 1) return guardImplicit(instances[0], instances, onFail)

  // 5. Ambiguous — never guess.
  onFail(
    'Multiple Hive instances are running — choose one with  --instance <name|kind>  or  --port <n>:\n' +
      listBlock(instances)
  )
}

// Find the bootstrap token for the SELECTED instance, most robust source first.
function resolveBootstrapTokenFor(instance) {
  // 1. Explicit override always wins.
  const fromEnv = process.env.HIVE_DESKTOP_BOOTSTRAP_TOKEN?.trim()
  if (fromEnv) return fromEnv

  // 2. The instance's own cli.json, written by Hive into its (per-worktree /
  //    ~/.hive) data dir at launch. Port-validated so a stale file is ignored.
  //    Works for the signed/notarized prod app (no argv scrape needed).
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

  // 3. Scrape the running app's argv, matched to THIS instance by port. Electron
  //    injects --hive-local-environment-bootstrap=<uri-encoded-JSON> into each
  //    renderer window; pick the blob whose ws/http port equals our instance.
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

// Exchange the selected instance's bootstrap token for a short-lived WS token.
// Returns null when no bootstrap token is discoverable (token-less / auth-off).
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
// Uses Node's built-in global WebSocket (no `ws` package) so this stays a single
// self-contained, dependency-free file.
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
    // A bad/expired WS token makes the server reject the HTTP upgrade with 401;
    // the global WebSocket surfaces that as an 'error' event before 'open'.
    const onError = (ev) => {
      cleanup()
      reject(new Error(`WS upgrade rejected (${ev?.message || 'bad/expired token?'}).`))
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })
}

// One round-trip on the RPC socket, matched by request id. A CLI must not hang if
// the socket stays open but no reply comes, so we add a timeout backstop, and we
// reject in-flight requests when the socket drops (mirrors the renderer transport).
let nextId = 0
function rpc(ws, method, params, timeoutMs = 15000) {
  const id = `cli-${(nextId += 1)}` // any non-empty string; UUID-free for readable logs
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

async function resolveProjectId(ws, wanted) {
  // A UUID is taken as an id verbatim — no lookup needed.
  if (wanted && UUID_RE.test(wanted)) return wanted

  const projects = await rpc(ws, 'db.project.getAll', {})
  if (!Array.isArray(projects) || projects.length === 0) {
    die('No projects exist in Hive yet. Create one in the app first.')
  }

  if (!wanted) {
    if (projects.length === 1) return projects[0].id
    die(
      'Multiple projects — specify one with --project <name|id>:\n' +
        projects.map((p) => `  - ${p.name}  (${p.id})`).join('\n')
    )
  }

  const lower = wanted.toLowerCase()
  const exact = projects.filter((p) => p.name?.toLowerCase() === lower)
  const matches = exact.length ? exact : projects.filter((p) => p.name?.toLowerCase().includes(lower))
  if (matches.length === 1) return matches[0].id
  if (matches.length === 0) {
    die(
      `No project matches "${wanted}". Available:\n` +
        projects.map((p) => `  - ${p.name}  (${p.id})`).join('\n')
    )
  }
  die(`"${wanted}" is ambiguous:\n` + matches.map((p) => `  - ${p.name}  (${p.id})`).join('\n'))
}

async function listProjects(ws) {
  const projects = await rpc(ws, 'db.project.getAll', {})
  if (!Array.isArray(projects) || projects.length === 0) {
    console.log('(no projects)')
    return
  }
  for (const p of projects) console.log(`${p.id}\t${p.name}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-CRUD `hive-ticket` surface. All subcommands are thin wrappers over RPCs
// that already exist server-side (kanban.ticket.* / kanban.dependency.*). The
// connection + auth + instance-selection boilerplate above is shared verbatim.
// ─────────────────────────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set([
  'create',
  'batch',
  'list',
  'get',
  'update',
  'move',
  'delete',
  'dep',
  'list-projects',
  'list-instances'
])

const USAGE = `hive-ticket — create/read/update/delete Hive kanban tickets over RPC.

  hive-ticket create "Title" ["Description"] ["todo|in_progress|review|done"]
  hive-ticket create --title "..." [--description "..."] [--column todo]
                     [--worktree <id>] [--depends-on <id[,id,...]>]
                     [--session <id>] [--mode build] [--gate [--gate-max N]
                     [--gate-provider p] [--gate-model m] [--gate-auto-done]]
  hive-ticket batch tickets.json           # array of { title, description?, column?,
                                           #   draftKey?, dependsOn?, worktreeId?, gate? }
  hive-ticket list [--column <col>] [--include-archived] [--json]
  hive-ticket get <id> [--json]
  hive-ticket update <id> [--title ..] [--description ..] [--column ..]
                          [--worktree <id>] [--mark ..] [--auto-approve-review true|false]
  hive-ticket move <id> <todo|in_progress|review|done> [sortOrder]
  hive-ticket delete <id>
  hive-ticket dep add <dependentId> <blockerId>
  hive-ticket dep remove <dependentId> <blockerId>
  hive-ticket list-projects
  hive-ticket list-instances

Target a specific Hive:  --instance <name|kind> | --port <n>
Project:  --project <name|id>  (or $HIVE_PROJECT_ID; auto when only one exists)
Env (auto-injected when launched by Hive):  HIVE_PORT, HIVE_PROJECT_ID,
  HIVE_WORKTREE_ID, HIVE_DATA_DIR, HIVE_DESKTOP_BOOTSTRAP_TOKEN`

// Build a condition-gate lifecycle config (mirrors the app's
// buildConditionGateConfig): a DURING(review) `evaluate` action marks the review
// ticket as a two-stage gate. Empty config keys are dropped.
export function buildGateConfig(flags) {
  const raw = {
    provider: flags['gate-provider'],
    model: flags['gate-model'],
    prompt: flags['gate-prompt'],
    maxRounds: flags['gate-max'] != null ? Number(flags['gate-max']) : undefined,
    autoDone: flags['gate-auto-done'] ? true : undefined
  }
  const config = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === '' || v === true) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    config[k] = v
  }
  return {
    enabled: true,
    states: {
      review: { during: [{ id: 'condition-gate-evaluate', type: 'evaluate', config }] }
    }
  }
}

export function parseColumn(value, ctx, onFail = die) {
  const column = value || 'todo'
  if (!COLUMNS.includes(column)) {
    onFail(`${ctx}: bad column "${column}". One of: ${COLUMNS.join(', ')}.`)
  }
  return column
}

export function splitList(value) {
  if (!value || value === true) return []
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function worktreeFrom(flags) {
  const w = flags.worktree || process.env.HIVE_WORKTREE_ID
  return w && w !== true ? String(w) : undefined
}

// Pure: turn one batch-file item into the `createBatch` draft shape. Exported so
// the mapping (aliases, gate expansion, launch-config serialization) is testable.
export function mapBatchDraft(item, index, projectId, fallbackWorktreeId, onFail = die) {
  if (!item.title) onFail(`Batch item ${index} is missing "title".`)
  const draft = {
    draft_key: item.draftKey || item.draft_key || `draft-${index}`,
    project_id: projectId,
    title: item.title,
    description: item.description ?? null,
    column: parseColumn(item.column, `Batch item ${index}`, onFail)
  }
  const worktreeId = item.worktreeId ?? item.worktree_id ?? fallbackWorktreeId
  if (worktreeId) draft.worktree_id = worktreeId
  const dependsOn = Array.isArray(item.dependsOn ?? item.depends_on) ? (item.dependsOn ?? item.depends_on) : []
  if (dependsOn.length) draft.depends_on = dependsOn
  if (item.gate) draft.lifecycle_callbacks = buildGateConfig(item.gate === true ? {} : item.gate)
  else if (item.lifecycle_callbacks) draft.lifecycle_callbacks = item.lifecycle_callbacks
  if (item.mode) draft.mode = item.mode
  if (item.autoApproveReview ?? item.auto_approve_review) draft.auto_approve_review = true
  // launchConfig (object) is serialized into pending_launch_config so the created
  // ticket auto-launches via Hive's queue machinery, sharing the threaded worktree.
  const launch = item.launchConfig ?? item.pending_launch_config
  if (launch) draft.pending_launch_config = typeof launch === 'string' ? launch : JSON.stringify(launch)
  return draft
}

async function cmdCreate(ws, projectId, flags, positional) {
  const title = flags.title || positional[1]
  if (!title) die('create: a title is required. See --help.')
  const description = flags.description ?? positional[2] ?? null
  const column = parseColumn(flags.column || positional[3], 'create')
  const worktreeId = worktreeFrom(flags)

  const params = { project_id: projectId, title, description, column }
  if (worktreeId) params.worktree_id = worktreeId
  if (flags.session && flags.session !== true) params.current_session_id = String(flags.session)
  if (flags.mode && flags.mode !== true) params.mode = String(flags.mode)
  if (flags.gate) params.lifecycle_callbacks = buildGateConfig(flags)

  const ticket = await rpc(ws, 'kanban.ticket.create', params)
  console.log(`Created: ${ticket.id} — ${ticket.title}  [${ticket.column}]`)

  // --depends-on: this new ticket depends on (is blocked by) each listed id.
  for (const blockerId of splitList(flags['depends-on'])) {
    await rpc(ws, 'kanban.dependency.add', { projectId, dependentId: ticket.id, blockerId })
    console.error(`  dep: ${ticket.id} depends on ${blockerId}`)
  }
  return ticket
}

async function cmdBatch(ws, projectId, flags, positional) {
  const file = flags.batch || positional[1]
  if (!file || file === true) die('batch: a JSON file path is required.')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(raw) || raw.length === 0) die('Batch file must be a non-empty JSON array.')
  const drafts = raw.map((t, i) => mapBatchDraft(t, i, projectId, worktreeFrom(flags)))
  const result = await rpc(ws, 'kanban.ticket.createBatch', { projectId, data: { drafts } })
  for (const t of result.tickets || []) console.log(`Created: ${t.id} — ${t.title}`)
}

async function cmdList(ws, projectId, flags) {
  const tickets = await rpc(ws, 'kanban.ticket.getByProject', {
    projectId,
    includeArchived: Boolean(flags['include-archived'])
  })
  const rows = Array.isArray(tickets) ? tickets : []
  const filtered =
    flags.column && flags.column !== true ? rows.filter((t) => t.column === flags.column) : rows
  if (flags.json) {
    console.log(JSON.stringify(filtered, null, 2))
    return
  }
  if (filtered.length === 0) {
    console.log('(no tickets)')
    return
  }
  for (const t of filtered) console.log(`${t.id}\t${t.column}\t${t.title}`)
}

async function cmdGet(ws, projectId, flags, positional) {
  const id = flags.id || positional[1]
  if (!id) die('get: a ticket id is required.')
  const ticket = await rpc(ws, 'kanban.ticket.get', { projectId, id })
  if (!ticket) die(`No ticket ${id} in this project.`)
  if (flags.json) {
    console.log(JSON.stringify(ticket, null, 2))
    return
  }
  console.log(`${ticket.id}\t${ticket.column}\t${ticket.title}`)
  if (ticket.description) console.log(ticket.description)
}

async function cmdUpdate(ws, projectId, flags, positional) {
  const id = flags.id || positional[1]
  if (!id) die('update: a ticket id is required.')
  const data = {}
  if (flags.title && flags.title !== true) data.title = String(flags.title)
  if ('description' in flags) data.description = flags.description === true ? null : flags.description
  if (flags.column && flags.column !== true) data.column = parseColumn(flags.column, 'update')
  const worktreeId = flags.worktree
  if (worktreeId !== undefined) data.worktree_id = worktreeId === true ? null : String(worktreeId)
  if (flags.mark && flags.mark !== true) data.mark = String(flags.mark)
  if ('auto-approve-review' in flags)
    data.auto_approve_review = String(flags['auto-approve-review']) === 'true'
  if (Object.keys(data).length === 0) die('update: nothing to change (pass --title/--column/…).')
  const ticket = await rpc(ws, 'kanban.ticket.update', { projectId, id, data })
  console.log(`Updated: ${ticket.id} — ${ticket.title}  [${ticket.column}]`)
}

async function cmdMove(ws, projectId, flags, positional) {
  const id = flags.id || positional[1]
  if (!id) die('move: a ticket id is required.')
  const column = parseColumn(flags.column || positional[2], 'move')
  const sortRaw = flags['sort-order'] ?? positional[3]
  // `kanban.ticket.move` REQUIRES a numeric sortOrder (strict schema). When the
  // caller doesn't specify a position, append to the end of the target column:
  // max existing sort_order + 1 (0 when the column has no other tickets).
  let sortOrder
  if (sortRaw != null && sortRaw !== true) {
    sortOrder = Number(sortRaw)
  } else {
    const tickets = await rpc(ws, 'kanban.ticket.getByProject', {
      projectId,
      includeArchived: false
    })
    const maxSort = (Array.isArray(tickets) ? tickets : [])
      .filter((t) => t.column === column && t.id !== id)
      .reduce((m, t) => Math.max(m, Number(t.sort_order ?? 0)), -1)
    sortOrder = maxSort + 1
  }
  const ticket = await rpc(ws, 'kanban.ticket.move', { projectId, id, column, sortOrder })
  console.log(`Moved: ${ticket.id} → ${ticket.column}`)
}

async function cmdDelete(ws, projectId, flags, positional) {
  const id = flags.id || positional[1]
  if (!id) die('delete: a ticket id is required.')
  await rpc(ws, 'kanban.ticket.delete', { projectId, id })
  console.log(`Deleted: ${id}`)
}

async function cmdDep(ws, projectId, positional) {
  const action = positional[1]
  const dependentId = positional[2]
  const blockerId = positional[3]
  if ((action !== 'add' && action !== 'remove') || !dependentId || !blockerId) {
    die('Usage: hive-ticket dep add|remove <dependentId> <blockerId>')
  }
  const method = action === 'add' ? 'kanban.dependency.add' : 'kanban.dependency.remove'
  await rpc(ws, method, { projectId, dependentId, blockerId })
  console.log(
    `dep ${action}: ${dependentId} ${action === 'add' ? 'now depends on' : 'no longer depends on'} ${blockerId}`
  )
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))

  if (flags.help || flags.h) {
    console.log(USAGE)
    return
  }

  // Subcommand is positional[0] when it's a known verb; otherwise fall back to the
  // legacy positional-create form (`hive-ticket "Title" …`) so existing callers work.
  const cmd = SUBCOMMANDS.has(positional[0]) ? positional[0] : null
  if (
    !cmd &&
    !positional[0] &&
    !flags.title &&
    !flags.batch &&
    !flags['list-projects'] &&
    !flags['list-instances']
  ) {
    console.log(USAGE)
    return
  }

  const instances = await discoverBackends()
  if (instances.length === 0) {
    die(
      `Cannot reach any Hive on ${HOST}:${PORT_START}-${PORT_END}. Is the app running?\n` +
        '(Override the host with HIVE_HOST if it listens elsewhere.)'
    )
  }

  if (cmd === 'list-instances' || flags['list-instances']) {
    console.log(listBlock(instances))
    return
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

  // Always show the chosen target on stderr (stdout stays machine-parseable).
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
    if (cmd === 'list-projects' || flags['list-projects']) {
      await listProjects(ws)
      return
    }

    const projectId = await resolveProjectId(ws, flags.project || process.env.HIVE_PROJECT_ID)

    switch (cmd) {
      case 'batch':
        return await cmdBatch(ws, projectId, flags, positional)
      case 'list':
        return await cmdList(ws, projectId, flags)
      case 'get':
        return await cmdGet(ws, projectId, flags, positional)
      case 'update':
        return await cmdUpdate(ws, projectId, flags, positional)
      case 'move':
        return await cmdMove(ws, projectId, flags, positional)
      case 'delete':
        return await cmdDelete(ws, projectId, flags, positional)
      case 'dep':
        return await cmdDep(ws, projectId, positional)
      case 'create':
        return void (await cmdCreate(ws, projectId, flags, positional))
    }

    // Legacy / flag forms with no explicit subcommand.
    if (flags.batch) return await cmdBatch(ws, projectId, flags, [])
    // Default: positional-create (`hive-ticket "Title" ["Desc"] ["column"]`).
    await cmdCreate(ws, projectId, flags, ['create', ...positional])
  } finally {
    ws.close()
  }
}

// Run only when executed directly (`node hive-ticket.mjs …` or via a `hive-ticket`
// symlink on PATH), not when imported by a test. Node resolves symlinks for
// `import.meta.url`, so we must resolve `argv[1]` too (realpathSync) — otherwise a
// symlinked invocation compares the link path against the real path and main()
// silently never runs.
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
