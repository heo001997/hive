import type { ClientConfig } from '@hive/client'
import type { DesktopBridge, LocalEnvironmentBootstrap } from './desktop-bridge'
import { clearWebAuth, createLocalStorageTokenStore, readStoredOwnerToken } from './web-auth'

export type BackendTargetSource = 'desktop' | 'vite' | 'browser'

export interface BackendTarget {
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly bootstrapToken: string | null
  readonly source: BackendTargetSource
}

export interface ResolveBackendTargetOptions {
  readonly desktopBridge?: Pick<DesktopBridge, 'getLocalEnvironmentBootstrap'> | null
  readonly env?: Record<string, string | undefined>
  readonly location?: Pick<Location, 'origin' | 'protocol' | 'host'>
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const normalizeHttpBaseUrl = (value: string): string => trimTrailingSlash(value.trim())

const normalizeWsBaseUrl = (value: string): string => {
  const trimmed = trimTrailingSlash(value.trim())
  return trimmed.endsWith('/ws') ? trimmed : `${trimmed}/ws`
}

const wsFromHttp = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = ''
  url.hash = ''
  return trimTrailingSlash(url.toString())
}

const fromBootstrap = (bootstrap: LocalEnvironmentBootstrap): BackendTarget => ({
  httpBaseUrl: normalizeHttpBaseUrl(bootstrap.httpBaseUrl),
  wsBaseUrl: normalizeWsBaseUrl(bootstrap.wsBaseUrl),
  bootstrapToken: bootstrap.bootstrapToken,
  source: 'desktop'
})

const getDefaultEnv = (): Record<string, string | undefined> => {
  return (
    (import.meta.env as Record<string, string | undefined> | undefined) ?? {}
  )
}

const getDefaultLocation = (): Pick<Location, 'origin' | 'protocol' | 'host'> | undefined =>
  typeof window === 'undefined' ? undefined : window.location

const getDefaultDesktopBridge = ():
  | Pick<DesktopBridge, 'getLocalEnvironmentBootstrap'>
  | null => (typeof window === 'undefined' ? null : (window.desktopBridge ?? null))

export const resolveBackendTarget = async (
  options: ResolveBackendTargetOptions = {}
): Promise<BackendTarget> => {
  const desktopBridge =
    options.desktopBridge === undefined ? getDefaultDesktopBridge() : options.desktopBridge
  const desktopBootstrap = await desktopBridge?.getLocalEnvironmentBootstrap()
  if (desktopBootstrap) return fromBootstrap(desktopBootstrap)

  const env = options.env ?? getDefaultEnv()
  const viteHttpBaseUrl = env.VITE_HIVE_HTTP_BASE_URL ?? env.VITE_HIVE_BACKEND_HTTP_BASE_URL
  if (viteHttpBaseUrl) {
    const httpBaseUrl = normalizeHttpBaseUrl(viteHttpBaseUrl)
    return {
      httpBaseUrl,
      wsBaseUrl: normalizeWsBaseUrl(
        env.VITE_HIVE_WS_BASE_URL ?? env.VITE_HIVE_BACKEND_WS_BASE_URL ?? wsFromHttp(httpBaseUrl)
      ),
      bootstrapToken: env.VITE_HIVE_BOOTSTRAP_TOKEN ?? null,
      source: 'vite'
    }
  }

  const location = options.location ?? getDefaultLocation()
  if (!location) {
    throw new Error('Unable to resolve Hive backend target without desktopBridge, Vite env, or window.location')
  }

  const httpBaseUrl = normalizeHttpBaseUrl(location.origin)
  return {
    httpBaseUrl,
    wsBaseUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    bootstrapToken: null,
    source: 'browser'
  }
}

// Synchronous WEB-mode detection, mirroring `resolveBackendTarget`'s precedence
// without awaiting the desktop bridge: a desktop preload bridge OR a Vite-dev
// backend env means we are NOT a hosted web client. Everything else (a plain
// browser served the built UI by the server) is web mode, where the owner-token
// login gate applies. Used by the renderer bootstrap to decide whether to show
// the Login screen; desktop + dev bridge return `false` and stay unchanged.
export const detectWebMode = (
  options: Pick<ResolveBackendTargetOptions, 'desktopBridge' | 'env'> = {}
): boolean => {
  const desktopBridge =
    options.desktopBridge === undefined ? getDefaultDesktopBridge() : options.desktopBridge
  if (desktopBridge) return false

  const env = options.env ?? getDefaultEnv()
  if (env.VITE_HIVE_HTTP_BASE_URL ?? env.VITE_HIVE_BACKEND_HTTP_BASE_URL) return false

  return typeof window !== 'undefined'
}

// Bridge from the renderer-resolved `BackendTarget` to the platform-neutral
// `ClientConfig` consumed by `@hive/client`'s `HiveClient`. All host detection
// (desktop bridge / Vite env / window.location) stays above in this file; the
// SDK itself receives only the resolved URLs + bootstrap token.
//
// In `browser` (hosted web) mode we additionally carry the durable owner token
// read from localStorage plus a localStorage-backed session `tokenStore`, so the
// SDK authenticates via `/api/auth/owner-exchange`. Desktop / Vite targets are
// unchanged (no owner token, default in-memory token store, no `onAuthError`).
// Web-mode terminal-auth recovery: clear the stored owner + session tokens and
// reload, which drops back to the WebLogin gate (no stored owner token now).
// Guarded so a non-browser host without `window` is a no-op.
const onWebAuthError = (): void => {
  clearWebAuth()
  if (typeof window !== 'undefined') window.location.reload()
}

export const backendTargetToClientConfig = (target: BackendTarget): ClientConfig => {
  if (target.source === 'browser') {
    return {
      baseUrl: target.wsBaseUrl,
      httpBaseUrl: target.httpBaseUrl,
      bootstrapToken: target.bootstrapToken,
      ownerToken: readStoredOwnerToken(),
      tokenStore: createLocalStorageTokenStore(),
      // Terminal auth failure (a rotated / rejected owner token surfaced as a
      // 401/403): the SDK has already stopped auto-reconnecting, so drop the
      // stored credentials and reload back to the WebLogin gate. This only wires
      // up for a hosted-web target — desktop / Vite-dev never reach here.
      onAuthError: onWebAuthError
    }
  }

  return {
    baseUrl: target.wsBaseUrl,
    httpBaseUrl: target.httpBaseUrl,
    bootstrapToken: target.bootstrapToken
  }
}
