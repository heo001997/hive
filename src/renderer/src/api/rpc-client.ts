// Thin shim. The process-wide RPC client registry now lives in the
// platform-neutral @hive/client SDK. It is re-exported here under the historical
// renderer names so the ~60 existing `@/api/rpc-client` imports keep working
// unchanged. Prefer importing from @hive/client directly in new code.
export {
  getHiveClient as getRendererRpcClient,
  setHiveClient as setRendererRpcClient,
  resetHiveClientForTests as resetRendererRpcClientForTests,
  type HiveRpcClient as RendererRpcClient
} from '@hive/client'
