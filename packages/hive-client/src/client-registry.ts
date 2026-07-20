// A tiny process-wide singleton registry for the active client. Extracted from
// src/renderer/src/api/rpc-client.ts and made host-neutral (the renderer names
// were "Renderer*"; here it is any host). Optional — hosts that prefer explicit
// dependency injection can ignore this and pass their `HiveClient` around.

import type { HiveClient } from './hive-client'

export type HiveRpcClient = Pick<HiveClient, 'request' | 'subscribe'>

let activeClient: HiveRpcClient | null = null

export const setHiveClient = (client: HiveRpcClient): void => {
  activeClient = client
}

export const getHiveClient = (): HiveRpcClient => {
  if (!activeClient) {
    throw new Error('Hive RPC client has not been initialized')
  }
  return activeClient
}

export const resetHiveClientForTests = (): void => {
  activeClient = null
}
