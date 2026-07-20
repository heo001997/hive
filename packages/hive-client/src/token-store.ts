// Pluggable token storage. `WsTransport`'s handshake caches the session access
// token here so a host can persist it (e.g. RN AsyncStorage, browser
// localStorage, an OS keychain) instead of holding it only in memory. Values may
// be resolved synchronously or asynchronously.

export interface TokenStore {
  get(): string | null | Promise<string | null>
  set(token: string): void | Promise<void>
  clear(): void | Promise<void>
}

/** Default in-process store — holds the token in a field, nothing persisted. */
export class MemoryTokenStore implements TokenStore {
  private token: string | null = null

  get(): string | null {
    return this.token
  }

  set(token: string): void {
    this.token = token
  }

  clear(): void {
    this.token = null
  }
}
