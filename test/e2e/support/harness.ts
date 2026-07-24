// E2E harness — shared launch/auth/fixture helpers for Hive Playwright specs.
//
// Extracted from browser-mode-smoke.spec.ts / electron-mode-smoke.spec.ts so every spec
// in the /speckit-e2e-* pipeline reuses one proven boot path instead of re-deriving it.
//
// Isolation model: each launch creates a fresh mkdtemp('hive-e2e-') base dir and points
// HIVE_SERVER_BASE_DIR (browser mode) / HOME (electron mode) at it — a brand-new SQLite
// DB per run, no shared state with dev/daily Hive or sibling worktrees. stop() tears the
// processes down and removes the dir. The 'hive-e2e-' prefix is load-bearing: the
// clean-e2e-env.sh orphan sweep keys on it.

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export interface RpcResponse<T = unknown> {
  readonly id?: string
  readonly ok?: boolean
  readonly value?: T
  readonly error?: unknown
}

export interface HiveApp {
  /** URL the renderer is served at — every spec's page.goto target. */
  readonly appUrl: string
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly bootstrapToken: string
  readonly baseDir: string
  /**
   * Server-side RPC call over the backend's WebSocket — SANCTIONED ONLY for the fixture
   * phase (seeding projects/settings before the journey) and for cited invisible-negative
   * assertions. Never a test ACTION; the journey drives the UI.
   */
  rpcCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<RpcResponse<T>>
  stop(): Promise<void>
}

export interface HiveElectronApp {
  readonly app: ElectronApplication
  readonly page: Page
  readonly baseDir: string
  readonly diagnostics: readonly string[]
  stop(): Promise<void>
}

const spawnChild = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {}
): ChildProcess =>
  spawn(command, [...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })

const stopChild = async (child: ChildProcess | null): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2_000).unref()
  })
}

interface HiveServerReadyEvent {
  readonly event: 'hive-server-ready'
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
}

const waitForHiveServer = (child: ChildProcess): Promise<HiveServerReadyEvent> =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let buffer = ''
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for hive-server-ready\n${stdout}\n${stderr}`))
    }, 15_000)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      buffer += chunk
      const lines = buffer.split(/\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'event' in parsed &&
          (parsed as { event: unknown }).event === 'hive-server-ready'
        ) {
          clearTimeout(timeout)
          resolve(parsed as HiveServerReadyEvent)
        }
      }
    })

    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Hive server exited before ready: code=${code} signal=${signal}\n${stderr}`))
    })
  })

// Vite colorizes its "Local:" line when FORCE_COLOR is inherited, which splices ANSI
// codes between the host and port — strip them before matching.
// eslint-disable-next-line no-control-regex -- deliberately matching the ANSI ESC byte
const stripAnsi = (s: string): string => s.replace(/\u001b?\[[0-9;]*m/g, '')

const waitForVite = (child: ChildProcess): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Vite dev server\n${output}`))
    }, 20_000)

    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      const match = stripAnsi(output).match(/Local:\s+(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/)/)
      if (match?.[1]) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Vite exited before ready: code=${code} signal=${signal}\n${output}`))
    })
  })

/**
 * Launch the full Hive stack in BROWSER mode (default drive mode for E2E):
 * backend = electron-as-node running out/main/server.js, renderer = vite web build,
 * both isolated in a fresh temp base dir. Requires a fresh `pnpm build`
 * (e2e-test.sh self-heals that).
 */
export const launchHiveBrowserApp = async (
  opts: { extraEnv?: NodeJS.ProcessEnv } = {}
): Promise<HiveApp> => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hive-e2e-'))
  const bootstrapToken = randomBytes(32).toString('base64url')
  let backend: ChildProcess | null = null
  let vite: ChildProcess | null = null

  try {
    // opts.extraEnv lets a spec inject backend env — e.g. a stub agent CLI on
    // PATH, or HIVE_WORKTREES_DIR confinement so a git-effect spec's real
    // `git worktree add` cannot leak into the dev worktrees dir.
    backend = spawnChild('pnpm', ['exec', 'electron', 'out/main/server.js'], {
      ELECTRON_RUN_AS_NODE: '1',
      HOME: baseDir,
      HIVE_SERVER_BASE_DIR: baseDir,
      HIVE_SERVER_MODE: 'browser',
      HIVE_SERVER_PORT: '0',
      HIVE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
      HIVE_SERVER_DEV_URL: 'http://127.0.0.1:5173',
      ...opts.extraEnv
    })
    const ready = await waitForHiveServer(backend)

    vite = spawnChild(
      'pnpm',
      [
        'exec',
        'vite',
        '--config',
        'vite.web.config.ts',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--clearScreen',
        'false'
      ],
      {
        VITE_HIVE_BOOTSTRAP_TOKEN: bootstrapToken,
        VITE_HIVE_HTTP_BASE_URL: ready.httpBaseUrl,
        VITE_HIVE_WS_BASE_URL: ready.wsBaseUrl,
        NO_COLOR: '1',
        FORCE_COLOR: '0'
      }
    )
    const appUrl = await waitForVite(vite)

    const rpcCall = async <T>(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<RpcResponse<T>> => {
      const bootstrapResponse = await fetch(`${ready.httpBaseUrl}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken })
      })
      if (!bootstrapResponse.ok) throw new Error(`bootstrap failed: ${bootstrapResponse.status}`)
      const auth = (await bootstrapResponse.json()) as { session: { accessToken: string } }
      const wsTokenResponse = await fetch(`${ready.httpBaseUrl}/api/auth/ws-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.session.accessToken}` }
      })
      if (!wsTokenResponse.ok) throw new Error(`ws-token failed: ${wsTokenResponse.status}`)
      const wsToken = (await wsTokenResponse.json()) as { webSocketToken: { token: string } }

      return await new Promise<RpcResponse<T>>((resolve, reject) => {
        const socket = new WebSocket(
          `${ready.wsBaseUrl}?token=${encodeURIComponent(wsToken.webSocketToken.token)}`
        )
        const id = `harness-${randomBytes(6).toString('hex')}`
        const timeout = setTimeout(() => {
          socket.close()
          reject(new Error(`RPC ${method} timed out`))
        }, 10_000)

        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ id, method, params }))
        })
        socket.addEventListener('message', (event) => {
          const parsed = JSON.parse(String(event.data)) as RpcResponse<T>
          if (parsed.id !== id) return // ignore server-push events
          clearTimeout(timeout)
          socket.close()
          resolve(parsed)
        })
        socket.addEventListener('error', () => {
          clearTimeout(timeout)
          reject(new Error(`RPC ${method} WebSocket failed`))
        })
      })
    }

    const stop = async (): Promise<void> => {
      await stopChild(vite)
      await stopChild(backend)
      rmSync(baseDir, { recursive: true, force: true })
    }

    return {
      appUrl,
      httpBaseUrl: ready.httpBaseUrl,
      wsBaseUrl: ready.wsBaseUrl,
      bootstrapToken,
      baseDir,
      rpcCall,
      stop
    }
  } catch (error) {
    await stopChild(vite)
    await stopChild(backend)
    rmSync(baseDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Launch Hive in ELECTRON mode (desktop-only surfaces: native window, desktopBridge, tray).
 * On Linux CI it self-provisions Xvfb; on macOS no display server is needed.
 */
export const launchHiveElectronApp = async (): Promise<HiveElectronApp> => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hive-e2e-'))
  const diagnostics: string[] = []

  let xvfb: ChildProcess | null = null
  let display = process.env.DISPLAY
  if (!display && process.platform === 'linux') {
    display = `:${120 + (process.pid % 1000)}`
    xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await new Promise((r) => setTimeout(r, 500))
  }

  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      args: ['out/main/index.js', '--no-sandbox', '--disable-gpu'],
      env: {
        ...process.env,
        ...(display ? { DISPLAY: display } : {}),
        HOME: baseDir,
        XDG_CONFIG_HOME: join(baseDir, '.config'),
        XDG_CACHE_HOME: join(baseDir, '.cache'),
        XDG_DATA_HOME: join(baseDir, '.local', 'share')
      }
    })
    app.on('window', (p) => {
      diagnostics.push(`window: ${p.url()}`)
      p.on('console', (m) => diagnostics.push(`console.${m.type()}: ${m.text()}`))
      p.on('pageerror', (e) => diagnostics.push(`pageerror: ${e.message}`))
    })
    const page = await app.firstWindow({ timeout: 30_000 })

    const stop = async (): Promise<void> => {
      await app?.close().catch(() => undefined)
      await stopChild(xvfb)
      rmSync(baseDir, { recursive: true, force: true })
    }

    return { app, page, baseDir, diagnostics, stop }
  } catch (error) {
    await app?.close().catch(() => undefined)
    await stopChild(xvfb)
    rmSync(baseDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Publish an event through the backend's sanctioned injection seam
 * `POST /api/events/publish` → real eventBus.publish → real WS server-push → the real
 * renderer listener the app subscribes to (`claude-cli:status` / `opencode:stream`).
 * The maximally-faithful analog of "a real agent pushed a status" in browser E2E, where
 * no real agent process exists to emit it (precondition 0.4, F3/F4). Fixture/injection
 * seam only — never a UI-journey action. Same bootstrap→accessToken flow as rpcCall.
 */
export const publishEvent = async (
  app: HiveApp,
  channel: string,
  payload: Record<string, unknown>
): Promise<void> => {
  const boot = await fetch(`${app.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: app.bootstrapToken })
  })
  if (!boot.ok) throw new Error(`bootstrap failed: ${boot.status}`)
  const auth = (await boot.json()) as { session: { accessToken: string } }
  const res = await fetch(`${app.httpBaseUrl}/api/events/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.session.accessToken}`
    },
    body: JSON.stringify({ channel, payload })
  })
  if (!res.ok) throw new Error(`publishEvent ${channel} failed: ${res.status}`)
}

/**
 * Create a throwaway git repo with one commit — the on-disk half of seeding a Hive
 * project (fixture phase only). Lives inside the OS temp dir with the hive-e2e- marker
 * so the cleanup sweep can find strays.
 */
export const makeTempGitRepo = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `hive-e2e-repo-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}-`))
  const run = (args: string[]): void => {
    const res = spawnSync('git', args, { cwd: dir, stdio: 'pipe' })
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${dir}: ${res.stderr?.toString()}`)
    }
  }
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 'e2e@hive.test'])
  run(['config', 'user.name', 'Hive E2E'])
  spawnSync('bash', ['-c', `echo "# ${name}" > README.md`], { cwd: dir })
  run(['add', '.'])
  run(['commit', '-m', 'init'])
  return dir
}

/**
 * Canonical screenshot helper — saves under test-results/screenshots/ so the execute
 * phase's copy step and the verify-template.sh gates find every capture in one place.
 */
export const screenshot = async (
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {}
): Promise<string> => {
  const dir = join(process.cwd(), 'test-results', 'screenshots')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.png`)
  await page.screenshot({ path, fullPage: options.fullPage ?? false })
  return path
}
