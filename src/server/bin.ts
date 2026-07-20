import { Effect } from 'effect'
import { startHiveServer, type StartedHiveServer } from './server'
import type { ServerConfig } from './config'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

interface ShutdownHandlerOptions {
  readonly exit?: (code: number) => void
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
  readonly timeoutMs?: number
}

export const createShutdownHandler = (
  server: Pick<StartedHiveServer, 'close'>,
  options: ShutdownHandlerOptions = {}
): (() => void) => {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const setTimeoutFn = options.setTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let shuttingDown = false
  let exited = false

  const exitOnce = (): void => {
    if (exited) return
    exited = true
    exit(0)
  }

  return (): void => {
    if (shuttingDown) {
      exitOnce()
      return
    }

    shuttingDown = true
    const timeout = setTimeoutFn(exitOnce, timeoutMs)

    void server.close().finally(() => {
      clearTimeoutFn(timeout)
      exitOnce()
    })
  }
}

// Structured, newline-delimited log lines on stderr. stdout is reserved for the
// single machine-parseable `hive-server-ready` event (below) so a supervisor or
// the Electron parent can consume it without stumbling over human-readable logs.
const log = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void => {
  process.stderr.write(
    JSON.stringify({ level, event, time: new Date().toISOString(), ...fields }) + '\n'
  )
}

// A redacted view of the resolved config safe to emit at startup. Secrets are
// NEVER logged — the owner token and desktop bootstrap token are reduced to
// booleans that only say WHETHER a credential is configured. File paths (data
// dir, TLS cert/key) are not secrets and are logged to aid operators.
export const buildConfigSummary = (config: ServerConfig): Record<string, unknown> => ({
  mode: config.mode,
  host: config.host,
  port: config.port,
  dataDir: config.baseDir,
  dbPath: config.dbPath,
  logsDir: config.logsDir,
  staticDir: config.staticDir,
  requireAuth: config.requireAuth,
  tlsEnabled: config.tlsEnabled,
  tlsCertPath: config.tlsCertPath,
  tlsKeyPath: config.tlsKeyPath,
  allowInsecure: config.allowInsecure,
  logLevel: config.logLevel,
  instanceKind: config.instanceKind,
  instanceLabel: config.instanceLabel,
  appVersion: config.appVersion,
  // Presence-only — the plaintext values are intentionally omitted.
  hasOwnerToken: config.ownerTokenEnv !== null,
  hasDesktopBootstrapToken: config.desktopBootstrapToken !== null
})

export const main = (): Promise<void> =>
  Effect.runPromise(startHiveServer()).then((server) => {
    log('info', 'hive-server-config', buildConfigSummary(server.config))
    log('info', 'hive-server-listening', {
      httpBaseUrl: server.httpBaseUrl,
      wsBaseUrl: server.wsBaseUrl,
      // A non-loopback bind with auth disabled or TLS off is a deliberate but
      // risky posture; surface it so it is visible in the operator's logs.
      standalone: !process.connected
    })

    // Machine-parseable readiness event on stdout (unchanged contract). The
    // Electron parent polls /.well-known/hive/environment for readiness, but
    // other supervisors may key off this line, so it is preserved verbatim.
    process.stdout.write(
      JSON.stringify({
        event: 'hive-server-ready',
        httpBaseUrl: server.httpBaseUrl,
        wsBaseUrl: server.wsBaseUrl
      }) + '\n'
    )

    const shutdown = createShutdownHandler(server)
    const onSignal = (signal: NodeJS.Signals): void => {
      log('info', 'hive-server-shutdown', { signal })
      shutdown()
    }

    process.on('SIGINT', () => onSignal('SIGINT'))
    process.on('SIGTERM', () => onSignal('SIGTERM'))
    // When launched as an Electron child over IPC, 'disconnect' fires the moment
    // the parent (the app's main process) closes the channel — i.e. when the app
    // dies, crashes, or relaunches. Without this the server child outlives its
    // parent as an orphan, keeping the HTTP/WS server and its ports bound (and its
    // own system-monitor sampler running) with no app to serve. No-op when run
    // standalone (no IPC channel, so the event never fires).
    process.on('disconnect', () => {
      log('info', 'hive-server-shutdown', { signal: 'disconnect' })
      shutdown()
    })
  })

const entryArg = process.argv[1] ?? ''

if (
  entryArg.endsWith('src/server/bin.ts') ||
  entryArg.endsWith('server/bin.js') ||
  entryArg.endsWith('server.js')
) {
  void main().catch((error: unknown) => {
    // A rejected startup (port in use, bad TLS material, invalid off-loopback
    // config, DB init failure, ...) is fatal for a supervised service: log it
    // and exit non-zero so systemd/launchd/Docker can restart or alert.
    log('error', 'hive-server-startup-failed', {
      error: error instanceof Error ? error.message : String(error)
    })
    process.exit(1)
  })
}
