import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `pnpm dev:stable` sets this to freeze the renderer: no chokidar file watching
// and no HMR, so merging a branch into main never auto-reloads the app (which
// would tear down the Claude Code PTY, reset React state, and drop the RPC
// WebSocket). Restart manually to pick up new code.
const isStable = process.env.HIVE_STABLE_DEV === 'true'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
          // The server (`src/server/bin.ts`) is built separately via
          // electron.vite.server.config.ts so it can be electron-free — it runs
          // as its own Node process and must not contain `require('electron')`.
        }
      }
    },
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': resolve('src/preload')
      }
    }
  },
  renderer: {
    assetsInclude: ['**/*.lottie'],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    // In stable mode, disable the file watcher (noop watcher) and HMR so disk
    // changes from a `git merge` are never picked up until the next restart.
    ...(isStable && {
      server: {
        watch: null,
        hmr: false
      }
    }),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pet: resolve(__dirname, 'src/renderer/pet.html')
        }
      }
    }
  }
})
