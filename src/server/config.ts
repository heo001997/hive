import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Effect } from 'effect'

export type ServerMode = 'desktop' | 'browser'
export type ServerLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ServerDerivedPaths {
  readonly stateDir: string
  readonly dbPath: string
  readonly attachmentsDir: string
  readonly logsDir: string
}

export type InstanceKind = 'production' | 'development'

export interface ServerConfig extends ServerDerivedPaths {
  readonly mode: ServerMode
  readonly host: string
  readonly port: number
  readonly baseDir: string
  readonly devUrl: string | null
  readonly staticDir: string | null
  readonly desktopBootstrapToken: string | null
  // Plaintext owner-token override from HIVE_OWNER_TOKEN (headless/CI). Never
  // persisted; accepted in addition to any minted (hashed) owner token.
  readonly ownerTokenEnv: string | null
  readonly requireAuth: boolean
  // TLS material for https/wss. Both must be present for TLS to engage; absent =
  // plain http (loopback/desktop default).
  readonly tlsCertPath: string | null
  readonly tlsKeyPath: string | null
  readonly tlsEnabled: boolean
  // Escape hatch: allow binding a non-loopback address over plain http.
  readonly allowInsecure: boolean
  // True when `host` is loopback-only (desktop/dev). Gates whether the opaque
  // "null" browser origin (the packaged file:// desktop renderer) is accepted on
  // the WS upgrade / HTTP CORS; a network-exposed server never accepts it.
  readonly loopbackBind: boolean
  readonly logLevel: ServerLogLevel
  // Extra browser origins (exact scheme://host[:port]) allowed to talk to this
  // server, on top of the always-allowed loopback origins. Shared by HTTP CORS
  // and the WebSocket upgrade so a real-origin SPA can be allowlisted.
  readonly allowedOrigins: readonly string[]
  // Identity for multi-instance discovery (prod / dev / per-worktree). Returned
  // only to non-browser callers of GET /.well-known/hive/environment.
  readonly instanceKind: InstanceKind
  readonly appVersion: string
  readonly instanceLabel: string
  readonly repoRoot: string
  readonly startedAt: string
}

export interface ServerConfigInput {
  readonly mode?: ServerMode
  readonly host?: string
  readonly port?: number
  readonly baseDir?: string
  readonly devUrl?: string | null
  readonly staticDir?: string | null
  readonly desktopBootstrapToken?: string | null
  readonly ownerTokenEnv?: string | null
  readonly requireAuth?: boolean
  readonly tlsCertPath?: string | null
  readonly tlsKeyPath?: string | null
  readonly allowInsecure?: boolean
  readonly allowedOrigins?: readonly string[]
  readonly logLevel?: ServerLogLevel
  readonly instanceKind?: InstanceKind
  readonly appVersion?: string
  readonly instanceLabel?: string
}

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 3773

export const deriveServerPaths = (baseDir: string): ServerDerivedPaths => {
  const stateDir = join(baseDir, 'userdata')
  return {
    stateDir,
    dbPath: join(stateDir, 'state.sqlite'),
    attachmentsDir: join(stateDir, 'attachments'),
    logsDir: join(stateDir, 'logs')
  }
}

const parsePort = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback
}

const parseMode = (value: string | undefined): ServerMode =>
  value === 'browser' || value === 'desktop' ? value : 'desktop'

const parseLogLevel = (value: string | undefined): ServerLogLevel =>
  value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info'

const parseRequireAuth = (value: string | undefined): boolean =>
  value === 'false' || value === '0' ? false : true

const parseBindIp = (value: string | undefined): string | undefined => {
  const bindIp = value?.trim()
  return bindIp ? bindIp : undefined
}

const parseAllowInsecure = (value: string | undefined): boolean =>
  value === 'true' || value === '1'

// Comma-separated list of extra browser origins (e.g.
// "https://app.example.com,https://admin.example.com"). Whitespace is trimmed
// and empty entries dropped. Loopback origins are always allowed regardless.
const parseAllowedOrigins = (value: string | undefined): readonly string[] => {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const LOOPBACK_ORIGIN_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']

// Shared allowed-origins policy for BOTH HTTP CORS and the WebSocket upgrade so
// the two never disagree. A browser Origin is allowed when it is a loopback
// http/https origin (the desktop renderer + the Vite dev server, e.g.
// http://localhost:5173) or an exact match of an explicitly configured origin
// (HIVE_SERVER_ALLOWED_ORIGINS). A real cross-origin (e.g. https://evil.com) is
// always rejected, which is what closes cross-site WebSocket hijacking (CSWSH).
// The opaque "null" origin (sent by file:// pages — including the packaged
// desktop renderer — and by sandboxed iframes) is accepted ONLY when
// allowNullOrigin is set, which callers derive from a loopback bind: the local
// desktop app must connect, and on loopback the threat model is already
// local-owner trust; a network-exposed (off-loopback) server keeps rejecting it.
// Non-browser clients (CLI, native apps, mobile RN) send NO Origin header at
// all; callers handle the absent-Origin case and do not route it through here.
export const isAllowedBrowserOrigin = (
  origin: string,
  allowedOrigins: readonly string[],
  allowNullOrigin = false
): boolean => {
  if (allowedOrigins.includes(origin)) return true
  if (origin === 'null') return allowNullOrigin
  try {
    const url = new URL(origin)
    const isLoopback = LOOPBACK_ORIGIN_HOSTNAMES.includes(url.hostname)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopback
  } catch {
    return false
  }
}

// A host is "loopback" when it can only be reached from the same machine.
// 0.0.0.0 / :: (all-interfaces) and any routable IP/hostname are NOT loopback and
// therefore expose the server to the network.
const isLoopbackHost = (host: string): boolean => {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.')
}

export const resolveServerConfig = (
  input: ServerConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): Effect.Effect<ServerConfig, Error> =>
  Effect.try({
    try: () => {
      const bindIp = parseBindIp(env.BIND_IP)
      const requireAuth = input.requireAuth ?? parseRequireAuth(env.HIVE_SERVER_REQUIRE_AUTH)
      if (bindIp && !requireAuth) {
        throw new Error('BIND_IP requires HIVE_SERVER_REQUIRE_AUTH=true')
      }

      const host = input.host ?? env.HIVE_SERVER_HOST ?? bindIp ?? DEFAULT_HOST
      const tlsCertPath = input.tlsCertPath ?? (env.HIVE_SERVER_TLS_CERT?.trim() || null)
      const tlsKeyPath = input.tlsKeyPath ?? (env.HIVE_SERVER_TLS_KEY?.trim() || null)
      const tlsEnabled = Boolean(tlsCertPath && tlsKeyPath)
      const allowInsecure = input.allowInsecure ?? parseAllowInsecure(env.HIVE_SERVER_ALLOW_INSECURE)

      // Off-loopback exposure requires both auth AND an encrypted transport, so an
      // owner token is never sent in the clear over the network. The explicit
      // HIVE_SERVER_ALLOW_INSECURE escape hatch is the only way to bypass TLS (e.g.
      // when terminating TLS at an upstream proxy).
      if (!isLoopbackHost(host)) {
        if (!requireAuth) {
          throw new Error(
            `Binding to a non-loopback address (${host}) requires HIVE_SERVER_REQUIRE_AUTH=true`
          )
        }
        if (!tlsEnabled && !allowInsecure) {
          throw new Error(
            `Binding to a non-loopback address (${host}) requires TLS: set ` +
              'HIVE_SERVER_TLS_CERT and HIVE_SERVER_TLS_KEY (file paths), or set ' +
              'HIVE_SERVER_ALLOW_INSECURE=true to bind over plain http (only safe ' +
              'behind a TLS-terminating proxy).'
          )
        }
      }

      // Precedence mirrors @main/services/hive-paths getHiveDataDir():
      // HIVE_DATA_DIR (dev override) > HIVE_SERVER_BASE_DIR (desktop child) > ~/.hive.
      const baseDir = resolve(
        input.baseDir ?? env.HIVE_DATA_DIR ?? env.HIVE_SERVER_BASE_DIR ?? join(homedir(), '.hive')
      )
      // The backend is spawned with cwd = the launching repo/worktree (or the
      // packaged app dir in prod), so process.cwd() identifies the worktree.
      const repoRoot = process.cwd()
      const instanceKind: InstanceKind =
        input.instanceKind ?? (env.HIVE_INSTANCE_KIND === 'production' ? 'production' : 'development')
      return {
        mode: input.mode ?? parseMode(env.HIVE_SERVER_MODE),
        host,
        port: input.port ?? parsePort(env.HIVE_SERVER_PORT, DEFAULT_PORT),
        baseDir,
        devUrl: input.devUrl ?? env.HIVE_SERVER_DEV_URL ?? null,
        staticDir: input.staticDir ?? env.HIVE_SERVER_STATIC_DIR ?? null,
        desktopBootstrapToken:
          input.desktopBootstrapToken ?? env.HIVE_DESKTOP_BOOTSTRAP_TOKEN ?? null,
        ownerTokenEnv: input.ownerTokenEnv ?? (env.HIVE_OWNER_TOKEN?.trim() || null),
        requireAuth,
        tlsCertPath,
        tlsKeyPath,
        tlsEnabled,
        allowInsecure,
        loopbackBind: isLoopbackHost(host),
        allowedOrigins:
          input.allowedOrigins ?? parseAllowedOrigins(env.HIVE_SERVER_ALLOWED_ORIGINS),
        logLevel: input.logLevel ?? parseLogLevel(env.HIVE_SERVER_LOG_LEVEL),
        instanceKind,
        appVersion: input.appVersion ?? env.HIVE_APP_VERSION ?? env.npm_package_version ?? '0.0.0',
        instanceLabel:
          input.instanceLabel ??
          (env.HIVE_INSTANCE_LABEL?.trim() ||
            (instanceKind === 'production' ? 'production' : basename(repoRoot) || 'hive')),
        repoRoot,
        startedAt: new Date().toISOString(),
        ...deriveServerPaths(baseDir)
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
  })
