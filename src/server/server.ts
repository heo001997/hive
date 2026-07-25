import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { Cause, Effect, Exit, Option } from 'effect'
import { z } from 'zod'
import { exchangeDesktopBootstrapToken } from './auth/bootstrap'
import {
  exchangeOwnerToken,
  hasOwnerCredential,
  OWNER_TOKEN_HASH_SETTING_KEY,
  type OwnerTokenDeps
} from './auth/owner'
import { getAuthSessionStatus, makeAuthSessionManager } from './auth/session'
import { makeEventBus } from './events/event-bus'
import {
  isAllowedBrowserOrigin,
  resolveServerConfig,
  type ServerConfig,
  type ServerConfigInput
} from './config'
import { makeRpcRouter } from './rpc/router'
import { attachWebSocketRpcServer } from './rpc/ws-server'
import { resolveStaticFile, serveStaticFile, type ResolvedStaticFile } from './static'
import { basename, sep } from 'node:path'
import { isDesktopBackendEventMessage } from '../shared/desktop-command'
import {
  disposeTerminalOutput,
  flushTerminalOutput,
  publishTerminalOutput
} from './rpc/domains/terminal-output-coalescer'
import {
  disposeTerminalLiveness,
  recordTerminalLiveness
} from './rpc/domains/terminal-liveness'
import { cleanupBranchWatchers } from '../main/services/branch-watcher'
import { setGitEventPublisher } from '../main/services/git-events'
import { systemMonitor } from '../main/services/system-monitor'
import { APP_SETTINGS_DB_KEY } from '../shared/types/settings'
import { setWorktreeEventPublisher } from '../main/services/worktree-events'
import { cleanupWorktreeWatchers } from '../main/services/worktree-watcher'
import {
  cleanupMarkdownKanbanWatchers,
  setMarkdownKanbanEventPublisher
} from '../main/services/markdown-kanban-watcher'
import { getDatabase } from '../main/db'

export interface StartedHiveServer {
  readonly config: ServerConfig
  readonly host: string
  readonly port: number
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly close: () => Promise<void>
}

// Forwards desktop→server backend events received over the Node IPC channel
// into the event bus (the low-latency replacement for the HTTP /api/events/publish
// hop). Tracked at module scope so a re-start swaps the handler instead of
// stacking listeners.
let desktopBackendEventForwarder: ((message: unknown) => void) | null = null

// The desktop backend talks to the Electron main process by issuing "desktop
// commands" over the Node IPC `message` channel. Each in-flight request in the
// RPC domains (terminal-ops, opencode-ops, …) registers its own short-lived
// `process.on('message', …)` listener and removes it once the matching reply
// arrives (or its timeout fires), so the listeners are self-draining and never
// leak. Node's default per-emitter cap is 10, though, so a normal burst of
// concurrent commands (startup, multi-session activity) plus the persistent
// forwarder above trips a spurious `MaxListenersExceededWarning`. Lift the cap
// to a value comfortably above realistic peak concurrency; it still surfaces a
// genuine runaway should one ever appear.
const BACKEND_PROCESS_MAX_LISTENERS = 100

export const startHiveServer = (
  input: ServerConfigInput = {}
): Effect.Effect<StartedHiveServer, Error> =>
  Effect.gen(function* () {
    const config = yield* resolveServerConfig(input)
    getDatabase().init()
    const eventBus = makeEventBus()

    // Raise the IPC `message` listener cap before any RPC handler can register
    // its per-request listener (see BACKEND_PROCESS_MAX_LISTENERS above).
    if (process.getMaxListeners() < BACKEND_PROCESS_MAX_LISTENERS) {
      process.setMaxListeners(BACKEND_PROCESS_MAX_LISTENERS)
    }

    if (desktopBackendEventForwarder) {
      process.off('message', desktopBackendEventForwarder)
    }
    desktopBackendEventForwarder = (message: unknown): void => {
      if (!isDesktopBackendEventMessage(message)) return
      const { channel, payload } = message
      // The desktop-main claude-cli PTYs forward their output here as raw
      // per-chunk events. Route it through the same visibility-aware coalescer
      // the server-owned shell PTYs use (see terminal-output-coalescer) so a
      // fleet of backgrounded agents doesn't flood the renderer's single
      // WebSocket parse loop. Non-terminal events publish straight through.
      if (channel.startsWith('terminal:data:') && typeof payload === 'string') {
        const terminalId = channel.slice('terminal:data:'.length)
        // Mirror main's PTY liveness into this process BEFORE the coalescer (which may
        // buffer a hidden terminal's output): `completionOps.getSessionFingerprint`
        // runs here and cannot see main's accumulator, and without this mirror every
        // frozen check silently degrades to the DB fallback (see terminal-liveness).
        recordTerminalLiveness(terminalId, payload)
        publishTerminalOutput(eventBus, terminalId, payload)
        return
      }
      if (channel.startsWith('terminal:exit:')) {
        // Drain buffered output before the exit notice so ordering holds.
        flushTerminalOutput(eventBus, channel.slice('terminal:exit:'.length))
        void Effect.runPromise(eventBus.publish({ channel, payload })).catch(() => undefined)
        disposeTerminalOutput(channel.slice('terminal:exit:'.length))
        disposeTerminalLiveness(channel.slice('terminal:exit:'.length))
        return
      }
      void Effect.runPromise(eventBus.publish({ channel, payload })).catch(() => undefined)
    }
    process.on('message', desktopBackendEventForwarder)

    setGitEventPublisher((channel, payload) =>
      Effect.runPromise(
        eventBus.publish({
          channel,
          payload
        })
      )
    )
    setWorktreeEventPublisher((channel, payload) =>
      Effect.runPromise(
        eventBus.publish({
          channel,
          payload
        })
      )
    )
    setMarkdownKanbanEventPublisher((channel, payload) =>
      Effect.runPromise(
        eventBus.publish({
          channel,
          payload
        })
      )
    )
    // The system monitor samples the whole Hive process tree from this server
    // child and streams snapshots/alerts to the renderer over the event bus
    // (same wiring as the git/worktree publishers above).
    systemMonitor.setPublisher((channel, payload) =>
      Effect.runPromise(eventBus.publish({ channel, payload }))
    )
    try {
      const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
      const settings = raw ? (JSON.parse(raw) as { systemMonitorEnabled?: boolean }) : {}
      // Default ON: background sampling for alerts + history even before the
      // panel is opened. Only an explicit `false` disables it.
      if (settings.systemMonitorEnabled !== false) {
        systemMonitor.setEnabled(true)
      }
    } catch {
      // setting may not exist yet — fall through with the default-on behaviour
      systemMonitor.setEnabled(true)
    }

    const authSessions = makeAuthSessionManager()
    const router = makeRpcRouter({ eventBus })

    // Owner-token credential source for the remote /api/auth/owner-exchange path.
    // Reads/writes the hash from the SAME settings store the mint/rotate RPC uses,
    // so a token minted over RPC is immediately honoured here. Never holds plaintext.
    const ownerTokenDeps: OwnerTokenDeps = {
      store: {
        getHash: () => getDatabase().getSetting(OWNER_TOKEN_HASH_SETTING_KEY),
        setHash: (hash) => getDatabase().setSetting(OWNER_TOKEN_HASH_SETTING_KEY, hash)
      },
      envOwnerToken: config.ownerTokenEnv
    }

    // Transport scheme derives from TLS: https/wss when cert+key are configured,
    // plain http/ws otherwise (the loopback/desktop default).
    const httpScheme = config.tlsEnabled ? 'https' : 'http'
    const wsScheme = config.tlsEnabled ? 'wss' : 'ws'

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<StartedHiveServer>((resolve, reject) => {
          const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
            const url = new URL(request.url ?? '/', `http://${request.headers.host ?? config.host}`)
            const corsOrigin = getAllowedCorsOrigin(
              request.headers.origin,
              config.allowedOrigins,
              config.loopbackBind
            )

            if (request.headers.origin && corsOrigin === null) {
              writeJson(response, 403, { error: 'Forbidden origin' })
              return
            }

            if (request.method === 'OPTIONS') {
              writeEmpty(response, 204, corsOrigin)
              return
            }

            const sessionStatus = getAuthSessionStatus(request.headers.authorization, authSessions)

            if (request.method === 'GET' && url.pathname === '/health') {
              writeJson(response, 200, { ok: true }, corsOrigin)
              return
            }

            if (request.method === 'GET' && url.pathname === '/.well-known/hive/environment') {
              const address = server.address()
              const port = typeof address === 'object' && address ? address.port : config.port
              // Identity fields (filesystem paths, labels) go ONLY to non-browser
              // callers — a request without an Origin header (CLI/tooling). Browsers
              // always send Origin, so a drive-by page or sandboxed iframe (origin
              // 'null', which CORS here permits) sees only the base connection
              // fields and never the host's paths. This lets a local CLI pick the
              // right instance among several running (prod / dev / per-worktree)
              // without leaking layout to the web.
              const identity = request.headers.origin
                ? {}
                : {
                    instanceKind: config.instanceKind,
                    label: config.instanceLabel,
                    appVersion: config.appVersion,
                    dataDir: config.baseDir,
                    repoRoot: config.repoRoot,
                    pid: process.pid,
                    startedAt: config.startedAt
                  }
              writeJson(
                response,
                200,
                {
                  mode: config.mode,
                  host: config.host,
                  port,
                  httpBaseUrl: `${httpScheme}://${config.host}:${port}`,
                  wsBaseUrl: `${wsScheme}://${config.host}:${port}/ws`,
                  hasDesktopBootstrapToken: config.desktopBootstrapToken !== null,
                  // Advertised so an off-machine client knows the owner-exchange
                  // path is usable before it presents a token.
                  hasOwnerToken: hasOwnerCredential(ownerTokenDeps),
                  ...identity
                },
                corsOrigin
              )
              return
            }

            if (request.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
              void readJson(request)
                .then(async (body) => {
                  const result = await Effect.runPromiseExit(
                    exchangeDesktopBootstrapToken(
                      body,
                      config.desktopBootstrapToken,
                      authSessions
                    )
                  )

                  Exit.match(result, {
                    onSuccess: (value) => writeJson(response, 200, value, corsOrigin),
                    onFailure: (cause) => {
                      const failure = Cause.failureOption(cause)
                      if (Option.isSome(failure)) {
                        writeJson(response, failure.value.statusCode, failure.value.body, corsOrigin)
                        return
                      }

                      writeJson(response, 500, { error: 'Authentication failed' }, corsOrigin)
                    }
                  })
                })
                .catch((error) => {
                  writeJson(
                    response,
                    400,
                    {
                      error: error instanceof Error ? error.message : 'Invalid request body'
                    },
                    corsOrigin
                  )
                })
              return
            }

            // Remote single-owner auth: exchange the durable owner token for an
            // AuthSession, identical in shape to /api/auth/bootstrap. The caller
            // then hits the unchanged /api/auth/ws-token endpoint. This is the
            // ONLY new public route; it never runs local-only logic and is safe to
            // expose off-machine (constant-time verify, hash-at-rest).
            if (request.method === 'POST' && url.pathname === '/api/auth/owner-exchange') {
              void readJson(request)
                .then(async (body) => {
                  const result = await Effect.runPromiseExit(
                    exchangeOwnerToken(body, ownerTokenDeps, authSessions)
                  )

                  Exit.match(result, {
                    onSuccess: (value) => writeJson(response, 200, value, corsOrigin),
                    onFailure: (cause) => {
                      const failure = Cause.failureOption(cause)
                      if (Option.isSome(failure)) {
                        writeJson(response, failure.value.statusCode, failure.value.body, corsOrigin)
                        return
                      }

                      writeJson(response, 500, { error: 'Authentication failed' }, corsOrigin)
                    }
                  })
                })
                .catch((error) => {
                  writeJson(
                    response,
                    400,
                    {
                      error: error instanceof Error ? error.message : 'Invalid request body'
                    },
                    corsOrigin
                  )
                })
              return
            }

            // Serve the built web UI (public — the page loads before any session
            // exists). API/WS/health routes keep priority: they are excluded here so
            // static serving never shadows an endpoint nor swallows a non-upgrade
            // GET /ws into the SPA fallback. resolveStaticFile() applies the
            // traversal guard (never serves outside staticDir) and the SPA fallback
            // (an in-app route that resolves to no real file returns index.html so a
            // browser refresh on any path still boots the app); a missing file with
            // an extension (e.g. a stale hashed asset) stays a 404 rather than
            // returning HTML.
            if (
              request.method === 'GET' &&
              config.staticDir &&
              !isReservedNonStaticRoute(url.pathname)
            ) {
              const resolved = resolveStaticFile(url.pathname, config.staticDir)
              if (resolved) {
                serveStaticFile(resolved, response, makeStaticHeaders(resolved, corsOrigin, request, config))
              } else {
                writeJson(response, 404, { error: 'Not Found' }, corsOrigin)
              }
              return
            }

            if (!isPublicHttpRoute(request.method, url.pathname) && !sessionStatus.authenticated) {
              writeJson(response, 401, { error: 'Unauthorized' }, corsOrigin)
              return
            }

            if (request.method === 'GET' && url.pathname === '/api/auth/session') {
              writeJson(response, 200, sessionStatus, corsOrigin)
              return
            }

            if (request.method === 'POST' && url.pathname === '/api/auth/ws-token') {
              const token = authSessions.createWebSocketToken(sessionStatus.session.accessToken)
              if (!token) {
                writeJson(response, 401, { error: 'Unauthorized' }, corsOrigin)
                return
              }

              writeJson(response, 200, { webSocketToken: token }, corsOrigin)
              return
            }

            if (request.method === 'POST' && url.pathname === '/api/events/publish') {
              void readJson(request)
                .then(async (body) => {
                  const event = eventPublishSchema.parse(body)
                  await Effect.runPromise(eventBus.publish(event))
                  writeJson(response, 200, { ok: true }, corsOrigin)
                })
                .catch((error) => {
                  writeJson(
                    response,
                    400,
                    {
                      error: error instanceof Error ? error.message : 'Invalid request body'
                    },
                    corsOrigin
                  )
                })
              return
            }

            writeJson(response, 404, { error: 'Not Found' }, corsOrigin)
          }

          // TLS (https/wss) when a cert+key pair is configured; plain http/ws
          // otherwise. The off-loopback guard in resolveServerConfig already
          // guarantees a non-loopback bind has either TLS or an explicit insecure
          // override, so a bare createServer here is only ever reached for loopback
          // or an operator-acknowledged insecure deployment.
          const server: Server = config.tlsEnabled
            ? (createHttpsServer(
                {
                  cert: readFileSync(config.tlsCertPath as string),
                  key: readFileSync(config.tlsKeyPath as string)
                },
                requestHandler
              ) as unknown as Server)
            : createServer(requestHandler)

          const wsServer = attachWebSocketRpcServer(server, router, eventBus, {
            // When auth is disabled (loopback web serving), accept token-less
            // upgrades so a plain browser can connect without a bootstrap token.
            authenticateToken: config.requireAuth
              ? (token) => authSessions.getWebSocketToken(token) !== null
              : undefined,
            // Origin allowlist matching HTTP CORS. Closes cross-site WebSocket
            // hijacking (CSWSH): even with auth disabled, a malicious cross-origin
            // page cannot open a ws:// to this backend and invoke RPCs. Non-browser
            // clients send no Origin and are unaffected.
            isOriginAllowed: (origin) =>
              isAllowedBrowserOrigin(origin, config.allowedOrigins, config.loopbackBind)
          })

          server.once('error', reject)
          server.listen(config.port, config.host, () => {
            server.off('error', reject)
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : config.port
            resolve({
              config,
              host: config.host,
              port,
              httpBaseUrl: `${httpScheme}://${config.host}:${port}`,
              wsBaseUrl: `${wsScheme}://${config.host}:${port}/ws`,
              close: async () => {
                wsServer.closeAll()
                await new Promise<void>((closeResolve, closeReject) => {
                  server.close((error) => {
                    if (error) closeReject(error)
                    else closeResolve()
                  })
                })
                await cleanupWorktreeWatchers()
                await cleanupBranchWatchers()
                await cleanupMarkdownKanbanWatchers()
                await import('../main/services/discord-service')
                  .then(({ discordService }) => discordService.stopListening())
                  .catch(() => undefined)
                systemMonitor.cleanup()
                systemMonitor.setPublisher(null)
                setGitEventPublisher(null)
                setWorktreeEventPublisher(null)
                setMarkdownKanbanEventPublisher(null)
                if (desktopBackendEventForwarder) {
                  process.off('message', desktopBackendEventForwarder)
                  desktopBackendEventForwarder = null
                }
              }
            })
          })
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
    })
  })

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  corsOrigin: string | null = null
): void => {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...makeCorsHeaders(corsOrigin)
  })
  response.end(body)
}

const writeEmpty = (
  response: ServerResponse,
  statusCode: number,
  corsOrigin: string | null = null
): void => {
  response.writeHead(statusCode, makeCorsHeaders(corsOrigin))
  response.end()
}

const makeCorsHeaders = (corsOrigin: string | null): Record<string, string> =>
  corsOrigin
    ? {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        Vary: 'Origin'
      }
    : {}

// HTTP CORS reflection. Shares the exact same allowlist as the WebSocket upgrade
// (see isAllowedBrowserOrigin) so the two transports never disagree on which
// origin is trusted. A missing Origin (non-browser caller) reflects nothing; a
// present-but-disallowed Origin returns null, which the request handler turns
// into a 403.
const getAllowedCorsOrigin = (
  origin: string | undefined,
  allowedOrigins: readonly string[],
  allowNullOrigin: boolean
): string | null => {
  if (!origin) return null
  return isAllowedBrowserOrigin(origin, allowedOrigins, allowNullOrigin) ? origin : null
}

// Routes that the static file server must never handle: the JSON/WS API, the
// WebSocket upgrade path (a non-upgrade GET /ws must not be answered with the SPA
// shell), the health probe, and the .well-known descriptor namespace. Everything
// else under a configured staticDir is a candidate for a built asset or the SPA
// fallback.
const isReservedNonStaticRoute = (pathname: string): boolean =>
  pathname === '/health' ||
  pathname === '/ws' ||
  pathname.startsWith('/ws/') ||
  pathname.startsWith('/api/') ||
  pathname.startsWith('/.well-known/')

// A content-hashed asset name (Vite emits e.g. `index-a1b2c3d4.js`). Combined
// with an `assets/` path segment to decide the immutable long-cache policy.
const HASHED_ASSET_NAME = /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i

// Cache-Control per served file: HTML (index.html, incl. the SPA fallback) must
// always be revalidated so a redeploy is picked up immediately; content-hashed
// build assets are immutable and safe to cache for a year; anything else gets a
// short, revalidated cache.
const cacheControlFor = (resolved: ResolvedStaticFile): string => {
  if (resolved.contentType.startsWith('text/html')) return 'no-cache'
  const inAssetsDir = resolved.filePath.includes(`${sep}assets${sep}`)
  if (inAssetsDir || HASHED_ASSET_NAME.test(basename(resolved.filePath))) {
    return 'public, max-age=31536000, immutable'
  }
  return 'public, max-age=3600'
}

// Content-Security-Policy for statically served HTML/assets. Operators can
// override the whole value via HIVE_SERVER_CSP (or set it to "off" to omit the
// header) when a customized build needs a looser policy — see docs/self-host.md.
//
// The default is intentionally strict:
// - script-src is 'self' (plus blob: for module workers) with NO 'unsafe-inline':
//   the Vite production build emits external module scripts only, so inline
//   scripts are never needed and are blocked.
// - style-src keeps 'unsafe-inline' because Vite/React/Tailwind inject <style>
//   tags and inline style attributes at runtime; dropping it would break rendering
//   and inline styles are not a script-execution vector.
// - connect-src is scoped to 'self' plus the same-origin WebSocket URL (derived
//   from the request Host and the TLS scheme), so the RPC socket can connect while
//   cross-origin exfiltration is blocked.
const resolveContentSecurityPolicy = (
  request: IncomingMessage,
  config: ServerConfig
): string | null => {
  const override = config.cspOverride
  if (override) return override.toLowerCase() === 'off' ? null : override

  const wsScheme = config.tlsEnabled ? 'wss' : 'ws'
  const host = request.headers.host ?? `${config.host}:${config.port}`
  const wsOrigin = `${wsScheme}://${host}`
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self' ${wsOrigin}`,
    "manifest-src 'self'"
  ].join('; ')
}

// Headers for a statically served file: CORS (shared with the API), the security
// baseline (CSP, nosniff, referrer policy), and a per-file Cache-Control.
const makeStaticHeaders = (
  resolved: ResolvedStaticFile,
  corsOrigin: string | null,
  request: IncomingMessage,
  config: ServerConfig
): Record<string, string> => {
  const headers: Record<string, string> = {
    ...makeCorsHeaders(corsOrigin),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': cacheControlFor(resolved)
  }
  const csp = resolveContentSecurityPolicy(request, config)
  if (csp) headers['Content-Security-Policy'] = csp
  return headers
}

const isPublicHttpRoute = (method: string | undefined, pathname: string): boolean =>
  (method === 'GET' && pathname === '/health') ||
  (method === 'GET' && pathname === '/.well-known/hive/environment') ||
  (method === 'POST' && pathname === '/api/auth/bootstrap') ||
  (method === 'POST' && pathname === '/api/auth/owner-exchange')

const eventPublishSchema = z
  .object({
    channel: z.string().min(1),
    payload: z.unknown()
  })
  .strict()

const readJson = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : null)
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
