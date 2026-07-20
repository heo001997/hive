import { Effect } from 'effect'
import { z } from 'zod'
import {
  getClaudeAccountEmail,
  getOpenAIAccountEmail
} from '../../../main/services/account-service'
import {
  listSavedAccounts,
  removeSavedAccount
} from '../../../main/services/saved-usage-orchestrator'
import type { SavedAccountDTO, UsageProvider } from '../../../shared/types/usage'
import { getDatabase } from '../../../main/db'
import {
  generateOwnerToken,
  hashOwnerToken,
  OWNER_TOKEN_HASH_SETTING_KEY,
  type OwnerTokenStore
} from '../../auth/owner'
import type { RpcHandler } from '../router'

export interface AccountOpsRpcService {
  readonly getClaudeEmail: () => Effect.Effect<string | null, unknown, never>
  readonly getOpenAIEmail: () => Effect.Effect<string | null, unknown, never>
  readonly listSaved: (provider?: UsageProvider) => Effect.Effect<SavedAccountDTO[], unknown, never>
  readonly removeSaved: (accountId: string) => Effect.Effect<boolean, unknown, never>
  // Durable owner-token lifecycle. Callable only from an already-authenticated
  // desktop/CLI session. Returns the plaintext token exactly once; only its hash
  // is persisted.
  readonly mintOwnerToken: () => Effect.Effect<{ ownerToken: string }, unknown, never>
  readonly rotateOwnerToken: () => Effect.Effect<{ ownerToken: string }, unknown, never>
}

// DB-backed owner-token hash store (settings key/value; no schema migration).
const makeOwnerTokenStore = (): OwnerTokenStore => ({
  getHash: () => getDatabase().getSetting(OWNER_TOKEN_HASH_SETTING_KEY),
  setHash: (hash) => getDatabase().setSetting(OWNER_TOKEN_HASH_SETTING_KEY, hash)
})

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const listSavedParamsSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']).optional()
  })
  .strict()
const removeSavedParamsSchema = z.object({ accountId: z.string() }).strict()

export const makeLiveAccountOpsRpcService = (): AccountOpsRpcService => ({
  getClaudeEmail: () =>
    Effect.tryPromise({
      try: () => getClaudeAccountEmail(),
      catch: (cause) => cause
    }),
  getOpenAIEmail: () =>
    Effect.tryPromise({
      try: () => getOpenAIAccountEmail(),
      catch: (cause) => cause
    }),
  listSaved: (provider) =>
    Effect.try({
      try: () => listSavedAccounts(provider),
      catch: (cause) => cause
    }),
  removeSaved: (accountId) =>
    Effect.try({
      try: () => removeSavedAccount(accountId),
      catch: (cause) => cause
    }),
  mintOwnerToken: () =>
    Effect.try({
      try: () => {
        const store = makeOwnerTokenStore()
        // Guarded create: refuse to silently clobber an existing token so an
        // accidental second mint can't invalidate a token already in use.
        if (store.getHash()) {
          throw new Error(
            'An owner token already exists. Use account.rotateOwnerToken to replace it.'
          )
        }
        const ownerToken = generateOwnerToken()
        store.setHash(hashOwnerToken(ownerToken))
        return { ownerToken }
      },
      catch: (cause) => cause
    }),
  rotateOwnerToken: () =>
    Effect.try({
      try: () => {
        const store = makeOwnerTokenStore()
        // Always replace: the previous token's hash is overwritten and stops
        // working immediately (existing minted sessions keep their TTL).
        const ownerToken = generateOwnerToken()
        store.setHash(hashOwnerToken(ownerToken))
        return { ownerToken }
      },
      catch: (cause) => cause
    })
})

export const makeAccountOpsRpcHandlers = (
  service: AccountOpsRpcService = makeLiveAccountOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'accountOps.getClaudeEmail',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getClaudeEmail()
        })
    ],
    [
      'accountOps.getOpenAIEmail',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getOpenAIEmail()
        })
    ],
    [
      'accountOps.listSaved',
      (params) =>
        Effect.gen(function* () {
          const { provider } = yield* Effect.try({
            try: () => listSavedParamsSchema.parse(params ?? {}),
            catch: (cause) => cause
          })
          return yield* service.listSaved(provider)
        })
    ],
    [
      'accountOps.removeSaved',
      (params) =>
        Effect.gen(function* () {
          const { accountId } = yield* Effect.try({
            try: () => removeSavedParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeSaved(accountId)
        })
    ],
    [
      'account.mintOwnerToken',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.mintOwnerToken()
        })
    ],
    [
      'account.rotateOwnerToken',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.rotateOwnerToken()
        })
    ]
  ])
