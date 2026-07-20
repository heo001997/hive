// App-wide auth + client state.
//
// Holds the single live `HiveClient` and the auth gate. On sign-in we validate
// the owner token, persist it (SecureStore) + the endpoints (AsyncStorage),
// build the client, and register for push. On a TERMINAL owner-auth failure the
// SDK's `onAuthError` fires -> we clear credentials and drop back to `signedOut`
// so the root navigator shows Login. Sign-out does the same on demand.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { HiveClient } from '@hive/client'

import {
  buildHiveClient,
  isAuthError,
  resolveServerEndpoints,
  validateOwnerToken
} from '../lib/hive'
import { registerForPush } from '../lib/push'
import {
  clearAllCredentials,
  getOwnerToken,
  getServerEndpoints,
  setOwnerToken,
  setServerEndpoints,
  type ServerEndpoints
} from '../lib/tokenStore'

type AuthState = 'loading' | 'signedOut' | 'signedIn'

interface HiveContextValue {
  readonly authState: AuthState
  /** The live client, or null when signed out. */
  readonly client: HiveClient | null
  /** Last-used server URL, for pre-filling the login form. */
  readonly lastServerUrl: string | null
  /** Validate + persist + connect. Throws on a rejected token (caught by UI). */
  signIn(serverUrl: string, ownerToken: string): Promise<void>
  /** Clear all credentials and close the client. */
  signOut(): Promise<void>
}

const HiveContext = createContext<HiveContextValue | null>(null)

export function HiveProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [client, setClient] = useState<HiveClient | null>(null)
  const [lastServerUrl, setLastServerUrl] = useState<string | null>(null)
  const clientRef = useRef<HiveClient | null>(null)

  const teardownClient = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
    }
    setClient(null)
  }, [])

  const handleAuthError = useCallback(
    (error: unknown) => {
      // Only a TERMINAL owner-auth rejection should bounce to Login. Transient
      // network/5xx failures never reach here (the SDK keeps reconnecting).
      if (!isAuthError(error)) return
      teardownClient()
      clearAllCredentials().finally(() => setAuthState('signedOut'))
    },
    [teardownClient]
  )

  const connect = useCallback(
    (endpoints: ServerEndpoints, ownerToken: string) => {
      teardownClient()
      const next = buildHiveClient({ endpoints, ownerToken, onAuthError: handleAuthError })
      clientRef.current = next
      setClient(next)
      setLastServerUrl(endpoints.httpBaseUrl)
      setAuthState('signedIn')
      // Fire-and-forget push registration; failure never blocks sign-in.
      void registerForPush(next)
      return next
    },
    [handleAuthError, teardownClient]
  )

  // Restore a persisted session on cold start.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [ownerToken, endpoints] = await Promise.all([
        getOwnerToken(),
        getServerEndpoints()
      ])
      if (cancelled) return
      if (ownerToken && endpoints) {
        connect(endpoints, ownerToken)
      } else {
        if (endpoints) setLastServerUrl(endpoints.httpBaseUrl)
        setAuthState('signedOut')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connect])

  const signIn = useCallback(
    async (serverUrl: string, ownerToken: string) => {
      const endpoints = await resolveServerEndpoints(serverUrl)
      // Validate BEFORE persisting so a bad token never gets stored.
      await validateOwnerToken(endpoints.httpBaseUrl, ownerToken)
      await setOwnerToken(ownerToken)
      await setServerEndpoints(endpoints)
      connect(endpoints, ownerToken)
    },
    [connect]
  )

  const signOut = useCallback(async () => {
    teardownClient()
    await clearAllCredentials()
    setAuthState('signedOut')
  }, [teardownClient])

  const value = useMemo<HiveContextValue>(
    () => ({ authState, client, lastServerUrl, signIn, signOut }),
    [authState, client, lastServerUrl, signIn, signOut]
  )

  return <HiveContext.Provider value={value}>{children}</HiveContext.Provider>
}

export function useHive(): HiveContextValue {
  const ctx = useContext(HiveContext)
  if (!ctx) throw new Error('useHive must be used within a HiveProvider')
  return ctx
}

/** Convenience: the live client, asserting we are signed in. */
export function useHiveClient(): HiveClient {
  const { client } = useHive()
  if (!client) throw new Error('Hive client is not connected (signed out)')
  return client
}
