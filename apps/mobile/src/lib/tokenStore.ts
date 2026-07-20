// Credential storage for the mobile client.
//
// Two very different secrets live here, held in two very different stores:
//
//   1. The OWNER TOKEN — the durable single-owner root secret the backend's
//      `/api/auth/owner-exchange` accepts. It is long-lived and grants full
//      access, so it goes in the OS keychain / keystore via `expo-secure-store`.
//      It is NEVER written to AsyncStorage, NEVER logged, and only ever handed
//      to `@hive/client`'s owner handshake.
//
//   2. The SESSION ACCESS TOKEN — the short-lived token `@hive/client` mints
//      from the owner token on each connect and re-mints on expiry. It is a
//      disposable cache, so it lives in AsyncStorage behind the `TokenStore`
//      contract the SDK expects. Losing or clearing it just forces one extra
//      owner-exchange round-trip.
//
// The server endpoints (http + ws base URLs) are not secret and live in
// AsyncStorage alongside the session token.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { TokenStore } from '@hive/client'

// SecureStore keys must be alphanumeric + ".", "-", "_" — no ":" or "/".
const OWNER_TOKEN_KEY = 'hive_owner_token'
const SESSION_TOKEN_KEY = 'hive.session.token'
const SERVER_HTTP_KEY = 'hive.server.httpBaseUrl'
const SERVER_WS_KEY = 'hive.server.wsBaseUrl'

export interface ServerEndpoints {
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
}

// ── Owner token (root secret, keychain-backed) ──────────────────────────────

export async function getOwnerToken(): Promise<string | null> {
  return SecureStore.getItemAsync(OWNER_TOKEN_KEY)
}

export async function setOwnerToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(OWNER_TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED
  })
}

export async function clearOwnerToken(): Promise<void> {
  await SecureStore.deleteItemAsync(OWNER_TOKEN_KEY)
}

// ── Server endpoints (not secret) ───────────────────────────────────────────

export async function getServerEndpoints(): Promise<ServerEndpoints | null> {
  const [httpBaseUrl, wsBaseUrl] = await Promise.all([
    AsyncStorage.getItem(SERVER_HTTP_KEY),
    AsyncStorage.getItem(SERVER_WS_KEY)
  ])
  if (!httpBaseUrl || !wsBaseUrl) return null
  return { httpBaseUrl, wsBaseUrl }
}

export async function setServerEndpoints(endpoints: ServerEndpoints): Promise<void> {
  await AsyncStorage.multiSet([
    [SERVER_HTTP_KEY, endpoints.httpBaseUrl],
    [SERVER_WS_KEY, endpoints.wsBaseUrl]
  ])
}

// ── Session-token store handed to @hive/client (disposable cache) ───────────

/**
 * A `TokenStore` backed by AsyncStorage. `@hive/client` caches the session
 * access token here between connects and clears it on a ws-token 401 so the
 * next connect re-runs the owner handshake.
 */
export function createSessionTokenStore(): TokenStore {
  return {
    get: () => AsyncStorage.getItem(SESSION_TOKEN_KEY),
    set: (token: string) => AsyncStorage.setItem(SESSION_TOKEN_KEY, token),
    clear: () => AsyncStorage.removeItem(SESSION_TOKEN_KEY)
  }
}

export async function clearSessionToken(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_TOKEN_KEY)
}

// Wipe every locally-held credential (owner token + session cache). Server
// endpoints are kept so the login screen can pre-fill the URL on re-auth.
export async function clearAllCredentials(): Promise<void> {
  await Promise.all([clearOwnerToken(), clearSessionToken()])
}
