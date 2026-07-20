import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'
import { isAllowedBrowserOrigin } from '../config'
import { attachWebSocketRpcServer } from '../rpc/ws-server'
import { makeEventBus } from '../events/event-bus'
import type { RpcRouter } from '../rpc/router'

// --- DB-free unit coverage of the upgrade gate itself ---------------------
// These drive attachWebSocketRpcServer directly (no getDatabase().init()), so
// they run even where the native sqlite binding is unavailable. They pin the
// exact CSWSH behaviour: reject a present-but-disallowed Origin, allow no-Origin
// and allowlisted/loopback Origins.

const noopRouter: RpcRouter = {
  handle: () =>
    Effect.succeed({ id: '', ok: false, error: { code: 'TEST', message: 'unused' } })
}

const rawUpgrade = (port: number, origin: string | undefined): Promise<string> =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = createConnection(port, '127.0.0.1')
    socket.once('error', reject)
    socket.once('connect', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ]
      if (origin !== undefined) lines.push(`Origin: ${origin}`)
      lines.push('\r\n')
      socket.write(lines.join('\r\n'))
    })
    socket.once('data', (chunk) => {
      socket.off('error', reject)
      const statusLine = chunk.toString('utf8').split('\r\n')[0]
      socket.destroy()
      resolve(statusLine.replace(/^HTTP\/1\.1\s+/, ''))
    })
  })

describe('isAllowedBrowserOrigin policy', () => {
  it('allows loopback http/https origins and configured origins, rejects the rest', () => {
    const allow = ['https://app.example.com']
    expect(isAllowedBrowserOrigin('http://localhost:5173', allow)).toBe(true)
    expect(isAllowedBrowserOrigin('http://127.0.0.1:3773', allow)).toBe(true)
    expect(isAllowedBrowserOrigin('https://app.example.com', allow)).toBe(true)
    expect(isAllowedBrowserOrigin('https://evil.example.com', allow)).toBe(false)
    expect(isAllowedBrowserOrigin('null', allow)).toBe(false)
    expect(isAllowedBrowserOrigin('http://localhost:5173', [])).toBe(true)
  })

  it('accepts the opaque "null" origin only when allowNullOrigin (loopback bind)', () => {
    const allow = ['https://app.example.com']
    // Default / off-loopback: the file:// or sandboxed-iframe origin is rejected.
    expect(isAllowedBrowserOrigin('null', allow, false)).toBe(false)
    // Loopback bind: the packaged file:// desktop renderer must connect.
    expect(isAllowedBrowserOrigin('null', allow, true)).toBe(true)
    // allowNullOrigin must NOT open real cross-origins.
    expect(isAllowedBrowserOrigin('https://evil.example.com', allow, true)).toBe(false)
  })
})

describe('WebSocket upgrade gate (direct, no DB)', () => {
  let server: Server | null = null
  let closeSockets: (() => void) | null = null

  afterEach(async () => {
    closeSockets?.()
    closeSockets = null
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  const listen = async (allowedOrigins: readonly string[]): Promise<number> => {
    server = createServer()
    const ws = attachWebSocketRpcServer(server, noopRouter, makeEventBus(), {
      isOriginAllowed: (origin) => isAllowedBrowserOrigin(origin, allowedOrigins)
    })
    closeSockets = ws.closeAll
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || !address) throw new Error('no address')
    return address.port
  }

  it('rejects a disallowed cross-origin upgrade with 403', async () => {
    const port = await listen([])
    await expect(rawUpgrade(port, 'https://evil.example.com')).resolves.toContain('403')
  })

  it('rejects the opaque "null" origin with 403', async () => {
    const port = await listen([])
    await expect(rawUpgrade(port, 'null')).resolves.toContain('403')
  })

  it('accepts an upgrade with no Origin header (non-browser client)', async () => {
    const port = await listen([])
    await expect(rawUpgrade(port, undefined)).resolves.toContain('101')
  })

  it('accepts the loopback dev renderer origin', async () => {
    const port = await listen([])
    await expect(rawUpgrade(port, 'http://localhost:5173')).resolves.toContain('101')
  })

  it('accepts an explicitly allowlisted real origin but not its neighbours', async () => {
    const port = await listen(['https://app.example.com'])
    await expect(rawUpgrade(port, 'https://app.example.com')).resolves.toContain('101')
    await expect(rawUpgrade(port, 'https://other.example.com')).resolves.toContain('403')
  })
})

// Sends a raw WebSocket upgrade to /ws and resolves with the HTTP status line
// of the handshake response (e.g. "101 Switching Protocols" or "403 Forbidden").
// `origin` is omitted entirely when undefined so we can exercise the
// non-browser (no Origin header) path.
const attemptUpgrade = (
  server: StartedHiveServer,
  origin: string | undefined
): Promise<string> =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket: Socket = createConnection(server.port, server.host)
    socket.once('error', reject)
    socket.once('connect', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: ${server.host}:${server.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ]
      if (origin !== undefined) lines.push(`Origin: ${origin}`)
      lines.push('\r\n')
      socket.write(lines.join('\r\n'))
    })
    socket.once('data', (chunk) => {
      socket.off('error', reject)
      const statusLine = chunk.toString('utf8').split('\r\n')[0]
      socket.destroy()
      // Strip the "HTTP/1.1 " prefix so callers assert on the code + reason.
      resolve(statusLine.replace(/^HTTP\/1\.1\s+/, ''))
    })
  })

describe('WebSocket upgrade origin allowlist (CSWSH guard)', () => {
  let started: StartedHiveServer | null = null

  afterEach(async () => {
    await started?.close()
    started = null
  })

  it('rejects an upgrade carrying a disallowed cross-origin Origin', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        requireAuth: false
      })
    )

    await expect(attemptUpgrade(started, 'https://evil.example.com')).resolves.toContain('403')
  })

  it('accepts the opaque "null" Origin on a loopback bind (packaged file:// desktop renderer)', async () => {
    // The default host is loopback (127.0.0.1), i.e. the desktop/dev case, where
    // the packaged renderer loads from file:// and sends Origin: null. It must be
    // allowed to connect. An off-loopback bind still rejects null (covered by the
    // isAllowedBrowserOrigin unit test with allowNullOrigin=false).
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        requireAuth: false
      })
    )

    await expect(attemptUpgrade(started, 'null')).resolves.toContain('101')
  })

  it('accepts an upgrade with no Origin header (non-browser: CLI / native / RN)', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        requireAuth: false
      })
    )

    await expect(attemptUpgrade(started, undefined)).resolves.toContain('101')
  })

  it('accepts an upgrade from the loopback dev renderer origin (localhost:5173)', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        requireAuth: false
      })
    )

    await expect(attemptUpgrade(started, 'http://localhost:5173')).resolves.toContain('101')
  })

  it('accepts an upgrade from an explicitly allowlisted real origin', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        requireAuth: false,
        allowedOrigins: ['https://app.example.com']
      })
    )

    await expect(attemptUpgrade(started, 'https://app.example.com')).resolves.toContain('101')
    await expect(attemptUpgrade(started, 'https://other.example.com')).resolves.toContain('403')
  })
})
