// @hive/client/node — Node-only helpers (backend discovery + bootstrap handshake).
// Imports Node built-ins (child_process/fs/os/path); do NOT import from a
// browser/RN bundle. The DOM-free client itself lives at the package root.

export {
  discoverBackends,
  describeBackend,
  selectBackend,
  isContextMatch,
  resolveBootstrapTokenFor,
  createNodeHiveClient,
  selfDataDir,
  gitToplevel,
  type DiscoveredBackend,
  type DiscoverBackendsOptions,
  type SelectContext,
  type NodeHiveClientOptions,
  type NodeHiveClientResult
} from './discovery'
