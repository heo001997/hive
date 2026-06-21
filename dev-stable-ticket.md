# Add `pnpm dev:stable` — disable HMR auto-reload in dev mode

## Problem

Running `pnpm dev` on `main` uses Vite HMR with full file watching.  
Every time a worktree branch merges into `main`, Vite detects the file changes and **auto-reloads the renderer** — which:

- Kills the running Claude Code terminal session (PTY torn down)
- Resets the In Progress ticket count timer (React state lost)
- Disconnects and reconnects the RPC WebSocket

User cannot control WHEN the app reloads — it just happens on every `git merge`.

---

## Goal

Add a `pnpm dev:stable` script that starts the Hive dev app **without HMR or file watching**.  
App loads once, stays stable. User restarts manually only when ready.

---

## Implementation

### 1. `package.json` — add new script

```json
"dev:stable": "HIVE_STABLE_DEV=true node scripts/dev-desktop.mjs"
```

> On Windows: wrap with `cross-env` if needed — check if `cross-env` is already a dev dependency.

---

### 2. `electron.vite.config.ts` — disable renderer watch/HMR when env var set

Current file is at `electron.vite.config.ts`. The `renderer` section has no `server` key — add one conditionally:

```ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const isStable = process.env.HIVE_STABLE_DEV === 'true'

export default defineConfig({
  main: {
    // ... unchanged ...
  },
  preload: {
    // ... unchanged ...
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
    // Disable file watching and HMR in stable mode — prevents auto-reload on merge
    ...(isStable && {
      server: {
        watch: null,   // disable chokidar file watcher
        hmr: false     // disable HMR WebSocket updates
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
```

---

## How It Works

| Mode | Command | HMR | File Watch | Auto-reload on merge |
|------|---------|-----|-----------|----------------------|
| Normal dev | `pnpm dev` | ✅ | ✅ | ✅ (kills sessions) |
| Stable dev | `pnpm dev:stable` | ❌ | ❌ | ❌ (sessions safe) |

With `HIVE_STABLE_DEV=true`:
- Vite dev server still starts (so Electron loads the renderer URL correctly)
- But `watch: null` tells Vite's chokidar not to watch any files
- `hmr: false` disables the HMR WebSocket push entirely
- Result: app stays frozen at the state it was when `pnpm dev:stable` was run

Main process and preload are already NOT watched by default (no `-w` flag passed to electron-vite), so no changes needed there.

---

## Usage After This Change

```bash
# Use this when you have real tickets running in In Progress
pnpm dev:stable

# Use this during active UI development where you want live reload
pnpm dev
```

To pick up latest `main` changes in stable mode: `Ctrl+C` → `pnpm dev:stable` again.

---

## Research Before Coding

1. Read `electron.vite.config.ts` — confirm current renderer section shape
2. Read `scripts/dev-desktop.mjs` — confirm env vars pass through to `electron-vite dev`
3. Grep for `cross-env` in `package.json` — add it if missing and targeting Windows compat
4. Test: run `pnpm dev:stable`, merge a branch into main, verify app does NOT reload
5. Test: run `pnpm dev`, make a renderer change, verify HMR still works normally

---

## Files Changed

- `package.json` — add `dev:stable` script (1 line)
- `electron.vite.config.ts` — add `isStable` flag + conditional `server` block on renderer (~8 lines)
