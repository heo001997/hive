import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import type { AuthSession, AuthSessionManager } from './session'

// Durable OWNER token for off-machine (browser/mobile) single-owner auth.
//
// This is NOT a parallel auth path: it plugs into the SAME session machinery the
// desktop bootstrap token uses. POST /api/auth/owner-exchange verifies the owner
// token and mints exactly the AuthSession bootstrap would; the caller then
// exchanges it for a 60s ws token via the unchanged /api/auth/ws-token endpoint.
//
// At rest we persist ONLY a SHA-256 hash of the token (in the existing settings
// key/value store — no schema migration). The plaintext is returned exactly once
// at mint/rotate time and is never recoverable afterwards. Comparison is constant
// time (timingSafeEqual over fixed-width 32-byte digests).

// Settings key holding the hex SHA-256 of the durable owner token. Namespaced so
// it never collides with the app_settings JSON blob.
export const OWNER_TOKEN_HASH_SETTING_KEY = 'auth.ownerTokenHash'

// Persistence seam for the owner-token hash. Backed by the DB settings store in
// production; trivially fakeable in tests. Never stores plaintext.
export interface OwnerTokenStore {
  readonly getHash: () => string | null
  readonly setHash: (hash: string) => void
}

export interface OwnerTokenDeps {
  readonly store: OwnerTokenStore
  // HIVE_OWNER_TOKEN env override for headless/CI: a plaintext owner token that is
  // accepted IN ADDITION to any minted one, without ever touching the DB.
  readonly envOwnerToken?: string | null
}

export interface OwnerExchangeResponse {
  readonly session: AuthSession
}

export interface OwnerExchangeFailure {
  readonly statusCode: 400 | 401 | 403
  readonly body: {
    readonly error: string
  }
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

// Hex SHA-256 of a token — the only representation ever written to disk.
export const hashOwnerToken = (token: string): string => sha256(token).toString('hex')

// 256 bits of CSPRNG entropy, URL-safe. Same generator the ws/session tokens use.
export const generateOwnerToken = (): string => randomBytes(32).toString('base64url')

// Constant-time equality over two digests. Both are fixed 32-byte SHA-256 buffers,
// so this never leaks length and never throws on mismatched widths.
const constantTimeDigestEqual = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b)

// Generate a fresh token, persist ONLY its hash, and return the plaintext once.
// Used by the rotate RPC (and, guarded, by mint) — the DURING/AFTER of rotation.
export const mintOwnerToken = (deps: OwnerTokenDeps): string => {
  const token = generateOwnerToken()
  deps.store.setHash(hashOwnerToken(token))
  return token
}

// True when at least one owner credential is configured (env override or minted).
export const hasOwnerCredential = (deps: OwnerTokenDeps): boolean =>
  Boolean(deps.envOwnerToken?.trim()) || Boolean(deps.store.getHash())

// Constant-time verification of a presented owner token against the env override
// and/or the stored hash. Hashing the candidate first keeps the compare width
// fixed regardless of input length.
export const verifyOwnerToken = (candidate: string, deps: OwnerTokenDeps): boolean => {
  if (!candidate) return false
  const candidateHash = sha256(candidate)

  const envToken = deps.envOwnerToken?.trim()
  if (envToken && constantTimeDigestEqual(candidateHash, sha256(envToken))) {
    return true
  }

  const storedHex = deps.store.getHash()
  if (storedHex) {
    // A malformed hex string yields a wrong-width buffer, which fails the length
    // guard rather than throwing — treated as "no match".
    const storedHash = Buffer.from(storedHex, 'hex')
    if (constantTimeDigestEqual(candidateHash, storedHash)) {
      return true
    }
  }

  return false
}

const ownerExchangeRequestSchema = z
  .object({
    ownerToken: z.string().min(1)
  })
  .strict()

// Owner-token → AuthSession exchange. Mirrors exchangeDesktopBootstrapToken's shape
// and reuses the same AuthSessionManager, so the rest of the chain (ws-token, ws
// upgrade) is entirely unchanged.
export const exchangeOwnerToken = (
  body: unknown,
  deps: OwnerTokenDeps,
  sessions: AuthSessionManager
): Effect.Effect<OwnerExchangeResponse, OwnerExchangeFailure> =>
  Effect.gen(function* () {
    const parsed = ownerExchangeRequestSchema.safeParse(body)
    if (!parsed.success) {
      return yield* Effect.fail({
        statusCode: 400 as const,
        body: { error: 'Invalid owner exchange request' }
      })
    }

    // No credential configured at all: this deployment hasn't enabled remote
    // owner auth. 403 (not 401) so clients can tell "disabled" from "wrong token".
    if (!hasOwnerCredential(deps)) {
      return yield* Effect.fail({
        statusCode: 403 as const,
        body: { error: 'Owner token not configured' }
      })
    }

    if (!verifyOwnerToken(parsed.data.ownerToken, deps)) {
      return yield* Effect.fail({
        statusCode: 401 as const,
        body: { error: 'Unauthorized' }
      })
    }

    return {
      session: sessions.createSession()
    }
  })
