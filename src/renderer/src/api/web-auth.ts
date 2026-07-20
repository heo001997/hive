// Browser (hosted-web) owner-token auth glue. This is the ONLY place the durable
// owner token — a root secret — is read from / written to persistent storage, and
// it lives in `localStorage` so a hosted web Hive survives reloads without a
// desktop bootstrap file. Desktop and Vite-dev modes never touch any of this.
//
// Two distinct localStorage keys:
//   - the OWNER token itself (the credential the user pastes on the Login screen)
//   - the short-lived SESSION access token the handshake mints from it
// The session token is a normal cache the handshake clears/re-mints on demand;
// the owner token is only cleared on explicit sign-out.
//
// The token is never logged and never leaves storage except as the request body
// of `/api/auth/owner-exchange` inside `@hive/client`.

import type { TokenStore } from '@hive/client'

const OWNER_TOKEN_STORAGE_KEY = 'hive.web.ownerToken'
const SESSION_TOKEN_STORAGE_KEY = 'hive.web.sessionAccessToken'

const getLocalStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    // Access can throw when storage is disabled (private mode / blocked cookies).
    return null
  }
}

// A `TokenStore` backed by a single localStorage key. Used for the SESSION access
// token so it is cached across reloads exactly like the desktop path caches it in
// memory. Falls back to a no-op when storage is unavailable.
export const createLocalStorageTokenStore = (
  key: string = SESSION_TOKEN_STORAGE_KEY
): TokenStore => ({
  get: () => getLocalStorage()?.getItem(key) ?? null,
  set: (token: string) => {
    getLocalStorage()?.setItem(key, token)
  },
  clear: () => {
    getLocalStorage()?.removeItem(key)
  }
})

export const readStoredOwnerToken = (): string | null =>
  getLocalStorage()?.getItem(OWNER_TOKEN_STORAGE_KEY) ?? null

export const hasStoredOwnerToken = (): boolean => Boolean(readStoredOwnerToken())

export const storeOwnerToken = (token: string): void => {
  getLocalStorage()?.setItem(OWNER_TOKEN_STORAGE_KEY, token)
}

// Sign-out: drop both the owner credential and the derived session token so the
// next load returns to the Login screen.
export const clearWebAuth = (): void => {
  const storage = getLocalStorage()
  storage?.removeItem(OWNER_TOKEN_STORAGE_KEY)
  storage?.removeItem(SESSION_TOKEN_STORAGE_KEY)
}
