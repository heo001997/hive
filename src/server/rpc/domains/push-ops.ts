import { Effect } from 'effect'
import { z } from 'zod'
import { getDatabase } from '../../../main/db'
import { createLogger } from '../../../main/services/logger'
import { toError } from '../../../main/services/error-utils'
import type { RpcHandler } from '../router'

/**
 * Dependency-free backend push dispatch via the Expo Push HTTP API.
 *
 * Device tokens are persisted in the settings key/value store (no schema
 * migration) as a JSON array under {@link PUSH_TOKENS_SETTING_KEY}. Dispatch is
 * wired alongside — never replacing — the Telegram notification path so the same
 * ticket lifecycle signals ("needs input"/question, review/stuck, done/PR ready)
 * that ping Telegram also fan out to Expo.
 *
 * Single-owner self-host: tokens are not cross-tenant secrets, but they are never
 * logged (log lines report counts only), and dead tokens are pruned on send.
 */

const PUSH_TOKENS_SETTING_KEY = 'push.deviceTokens'
const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send'
// Expo rejects batches larger than 100 messages per request.
const EXPO_MAX_BATCH = 100

const log = createLogger({ component: 'PushOpsRpc' })

export type PushPlatform = 'ios' | 'android' | 'web'

export interface StoredPushToken {
  readonly token: string
  readonly platform: PushPlatform
  readonly registeredAt: string
}

export interface PushRegisterResult {
  readonly ok: boolean
  readonly count: number
}

export interface PushSendResult {
  readonly ok: boolean
  /** Number of tokens a message was accepted for. */
  readonly sent: number
  /** Tokens dropped because Expo reported them as no longer registered. */
  readonly dropped: number
}

// ---------------------------------------------------------------------------
// Token store (settings key/value; no migration)
// ---------------------------------------------------------------------------

const storedTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
  registeredAt: z.string()
})
const storedTokensSchema = z.array(storedTokenSchema)

const readTokens = (): StoredPushToken[] => {
  const raw = getDatabase().getSetting(PUSH_TOKENS_SETTING_KEY)
  if (!raw) return []
  try {
    const parsed = storedTokensSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    // Corrupt/legacy value — treat as empty rather than throwing on every send.
    return []
  }
}

const writeTokens = (tokens: readonly StoredPushToken[]): void => {
  getDatabase().setSetting(PUSH_TOKENS_SETTING_KEY, JSON.stringify(tokens))
}

const registerToken = (token: string, platform: PushPlatform): number => {
  const tokens = readTokens()
  const existing = tokens.filter((t) => t.token !== token)
  existing.push({ token, platform, registeredAt: new Date().toISOString() })
  writeTokens(existing)
  return existing.length
}

const unregisterToken = (token: string): number => {
  const tokens = readTokens()
  const next = tokens.filter((t) => t.token !== token)
  if (next.length !== tokens.length) writeTokens(next)
  return next.length
}

const dropTokens = (dead: ReadonlySet<string>): void => {
  if (dead.size === 0) return
  const tokens = readTokens()
  const next = tokens.filter((t) => !dead.has(t.token))
  if (next.length !== tokens.length) writeTokens(next)
}

// ---------------------------------------------------------------------------
// Expo Push HTTP dispatch (dependency-free; uses global fetch)
// ---------------------------------------------------------------------------

interface ExpoPushMessage {
  to: string
  title?: string
  body?: string
  data?: Record<string, unknown>
  sound: 'default'
}

// Expo returns one ticket per message, positionally aligned with the request.
const expoTicketSchema = z.object({
  status: z.enum(['ok', 'error']).optional(),
  message: z.string().optional(),
  details: z.object({ error: z.string().optional() }).partial().optional()
})
const expoResponseSchema = z.object({
  data: z.array(expoTicketSchema).optional()
})

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * POST a push to every registered device via the Expo Push API. Best-effort and
 * never throws: transient/network failures are logged (without token values) and
 * swallowed so a push failure can never disrupt the Telegram path it rides
 * alongside. Tokens Expo reports as `DeviceNotRegistered` are pruned from the
 * store so they aren't retried forever.
 */
export const sendPush = async (message: {
  title: string
  body: string
  data?: Record<string, unknown>
}): Promise<PushSendResult> => {
  const tokens = readTokens()
  if (tokens.length === 0) return { ok: true, sent: 0, dropped: 0 }

  const dead = new Set<string>()
  let sent = 0

  for (const batch of chunk(tokens, EXPO_MAX_BATCH)) {
    const payload: ExpoPushMessage[] = batch.map((t) => ({
      to: t.token,
      title: message.title,
      body: message.body,
      data: message.data,
      sound: 'default'
    }))
    try {
      const response = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })
      if (!response.ok) {
        log.warn('push dispatch HTTP error', { status: response.status, batch: batch.length })
        continue
      }
      const parsed = expoResponseSchema.safeParse(await response.json())
      const tickets = parsed.success ? (parsed.data.data ?? []) : []
      batch.forEach((t, i) => {
        const ticket = tickets[i]
        if (ticket?.status === 'error') {
          // Positional alignment: drop tokens Expo rejects at TICKET time.
          // NOTE: most dead tokens (uninstalled/expired apps) surface only in the
          // later RECEIPT (GET /push/getReceipts), not the ticket, so this prunes
          // only the immediate cases. Full cleanup = a receipt-polling follow-up.
          if (ticket.details?.error === 'DeviceNotRegistered') dead.add(t.token)
        } else {
          sent += 1
        }
      })
    } catch (error) {
      // Network / JSON failure — log without any token material.
      log.warn('push dispatch failed', { error: toError(error).message, batch: batch.length })
    }
  }

  dropTokens(dead)
  return { ok: true, sent, dropped: dead.size }
}

export interface TicketPushContext {
  /**
   * The hive session id the notification is about. When present it is placed in
   * the push `data` so a tap deep-links into that session (the mobile app reads
   * `data.hiveSessionId`). Callers that have the id should pass it; those that
   * don't still send a valid notification (the app falls back to the session
   * list on tap).
   */
  readonly hiveSessionId?: string
}

/**
 * Fire a push mirroring a Telegram ticket-notification line. Splits an optional
 * leading "<label>: <detail>" into title/body so the notification reads well,
 * falling back to a generic title. Fire-and-forget; never throws.
 */
export const dispatchTicketPush = (text: string, context: TicketPushContext = {}): void => {
  const trimmed = text.trim()
  if (!trimmed) return
  const sep = trimmed.indexOf(': ')
  const title = sep > 0 ? trimmed.slice(0, sep) : 'Hive'
  const body = sep > 0 ? trimmed.slice(sep + 2) : trimmed
  const data = context.hiveSessionId ? { hiveSessionId: context.hiveSessionId } : undefined
  void sendPush({ title, body, data }).catch((error) => {
    log.warn('dispatchTicketPush failed', { error: toError(error).message })
  })
}

// ---------------------------------------------------------------------------
// RPC service
// ---------------------------------------------------------------------------

export interface PushOpsRpcService {
  readonly register: (
    token: string,
    platform: PushPlatform
  ) => Effect.Effect<PushRegisterResult, unknown, never>
  readonly unregister: (token: string) => Effect.Effect<PushRegisterResult, unknown, never>
}

export const makeLivePushOpsRpcService = (): PushOpsRpcService => ({
  register: (token, platform) =>
    Effect.try({
      try: () => ({ ok: true, count: registerToken(token, platform) }),
      catch: (cause) => cause
    }),
  unregister: (token) =>
    Effect.try({
      try: () => ({ ok: true, count: unregisterToken(token) }),
      catch: (cause) => cause
    })
})

const registerParamsSchema = z
  .object({
    token: z.string().min(1),
    platform: z.enum(['ios', 'android', 'web'])
  })
  .strict()
const unregisterParamsSchema = z.object({ token: z.string().min(1) }).strict()

export const makePushOpsRpcHandlers = (
  service: PushOpsRpcService = makeLivePushOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'push.register',
      (params) =>
        Effect.gen(function* () {
          const { token, platform } = yield* Effect.try({
            try: () => registerParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.register(token, platform)
        })
    ],
    [
      'push.unregister',
      (params) =>
        Effect.gen(function* () {
          const { token } = yield* Effect.try({
            try: () => unregisterParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unregister(token)
        })
    ]
  ])
