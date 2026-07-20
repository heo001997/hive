// Metro config for the pnpm workspace.
//
// `@hive/client` is a workspace package that ships RAW TypeScript source
// (`packages/hive-client/src/index.ts`, resolved via its package `exports`).
// pnpm links it into `apps/mobile/node_modules/@hive/client` as a symlink into
// the virtual store at the repo root. For Metro to (a) follow that symlink,
// (b) resolve the package's `exports` map to `./src/index.ts`, and (c) watch
// and transform that source, we must:
//   - add the workspace root to `watchFolders`, and
//   - point `nodeModulesPaths` at BOTH the app's and the repo-root store, and
//   - enable symlink following + package `exports` resolution.
//
// NOTE for pnpm: do NOT set `resolver.disableHierarchicalLookup = true`.
// pnpm relies on nested `node_modules/.pnpm/...` symlinks that Metro reaches
// via hierarchical lookup; disabling it (a common Yarn-workspaces tip) breaks
// pnpm dependency resolution.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..', '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
]

// Metro >= 0.80 (Expo SDK 50+) follows symlinks and honours package `exports`.
// Kept explicit so a self-hosting dev on an older toolchain still resolves
// `@hive/client` to its `src/index.ts` entry.
config.resolver.unstable_enableSymlinks = true
config.resolver.unstable_enablePackageExports = true

module.exports = config
