import { Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  exchangeOwnerToken,
  generateOwnerToken,
  hashOwnerToken,
  hasOwnerCredential,
  mintOwnerToken,
  verifyOwnerToken,
  type OwnerTokenDeps,
  type OwnerTokenStore
} from '../auth/owner'
import { makeAuthSessionManager } from '../auth/session'

const makeMemoryStore = (initial: string | null = null): OwnerTokenStore => {
  let hash = initial
  return {
    getHash: () => hash,
    setHash: (value) => {
      hash = value
    }
  }
}

describe('owner-token auth', () => {
  it('mints a token, persists only its hash, and verifies it', () => {
    const store = makeMemoryStore()
    const deps: OwnerTokenDeps = { store }

    const token = mintOwnerToken(deps)

    expect(token).toBeTypeOf('string')
    expect(token.length).toBeGreaterThan(0)
    // Only the hash is at rest — never the plaintext.
    expect(store.getHash()).toBe(hashOwnerToken(token))
    expect(store.getHash()).not.toContain(token)

    expect(verifyOwnerToken(token, deps)).toBe(true)
    expect(verifyOwnerToken('wrong-token', deps)).toBe(false)
    expect(verifyOwnerToken('', deps)).toBe(false)
  })

  it('accepts the HIVE_OWNER_TOKEN env override without a stored hash', () => {
    const deps: OwnerTokenDeps = {
      store: makeMemoryStore(),
      envOwnerToken: 'ci-owner-token'
    }

    expect(hasOwnerCredential(deps)).toBe(true)
    expect(verifyOwnerToken('ci-owner-token', deps)).toBe(true)
    expect(verifyOwnerToken('nope', deps)).toBe(false)
  })

  it('rejects a malformed stored hash rather than throwing', () => {
    const deps: OwnerTokenDeps = { store: makeMemoryStore('not-hex-!!!') }
    expect(verifyOwnerToken('anything', deps)).toBe(false)
  })

  it('rotation invalidates the previous token', () => {
    const store = makeMemoryStore()
    const deps: OwnerTokenDeps = { store }
    const first = mintOwnerToken(deps)
    const second = mintOwnerToken(deps)

    expect(first).not.toBe(second)
    expect(verifyOwnerToken(first, deps)).toBe(false)
    expect(verifyOwnerToken(second, deps)).toBe(true)
  })

  it('exchanges a valid owner token for an AuthSession', async () => {
    const store = makeMemoryStore()
    const deps: OwnerTokenDeps = { store }
    const token = mintOwnerToken(deps)
    const sessions = makeAuthSessionManager()

    const result = await Effect.runPromise(exchangeOwnerToken({ ownerToken: token }, deps, sessions))

    expect(result.session.tokenType).toBe('Bearer')
    // The minted session flows through the SAME manager the ws-token step reads.
    expect(sessions.getSession(result.session.accessToken)).not.toBeNull()
    expect(sessions.createWebSocketToken(result.session.accessToken)).not.toBeNull()
  })

  it('rejects the exchange with 403 when no owner credential is configured', async () => {
    const deps: OwnerTokenDeps = { store: makeMemoryStore() }
    const exit = await Effect.runPromiseExit(
      exchangeOwnerToken({ ownerToken: 'x' }, deps, makeAuthSessionManager())
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
      expect(exit.cause.error.statusCode).toBe(403)
    }
  })

  it('rejects the exchange with 401 on a wrong owner token', async () => {
    const store = makeMemoryStore()
    const deps: OwnerTokenDeps = { store }
    mintOwnerToken(deps)

    const exit = await Effect.runPromiseExit(
      exchangeOwnerToken({ ownerToken: 'wrong' }, deps, makeAuthSessionManager())
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
      expect(exit.cause.error.statusCode).toBe(401)
    }
  })

  it('rejects the exchange with 400 on a malformed body', async () => {
    const deps: OwnerTokenDeps = { store: makeMemoryStore(), envOwnerToken: 'tok' }
    const exit = await Effect.runPromiseExit(
      exchangeOwnerToken({ notOwnerToken: true }, deps, makeAuthSessionManager())
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
      expect(exit.cause.error.statusCode).toBe(400)
    }
  })

  it('generateOwnerToken produces distinct high-entropy tokens', () => {
    const a = generateOwnerToken()
    const b = generateOwnerToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(43) // 32 bytes base64url
  })
})
