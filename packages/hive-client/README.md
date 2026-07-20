# @hive/client

Platform-neutral Hive RPC SDK — the renderer's WebSocket transport + bootstrap
handshake, extracted with every DOM / Electron / Vite assumption removed. Runs in
the browser, Node (>=22) and React Native. **Zero runtime dependencies.**

Everything host-specific is injected via `ClientConfig`:

- `webSocketImpl` — the `WebSocket` constructor (browser / Node global / RN). Defaults to `globalThis.WebSocket`.
- `fetchImpl` — `fetch` for the auth handshake. Defaults to `globalThis.fetch`.
- `tokenStore` — `get/set/clear` for the cached session token. Defaults to `MemoryTokenStore`.
- `baseUrl` — the WebSocket URL (a `/ws` path).

## Browser / RN

```ts
import { HiveClient } from '@hive/client'

const client = new HiveClient({
  baseUrl: 'wss://host/ws',
  httpBaseUrl: 'https://host',
  bootstrapToken, // omit for a token-less dev server
  webSocketImpl: WebSocket // or the RN WebSocket
})

const projects = await client.request('db.project.getAll', {})
const unsub = client.subscribe('kanban.tickets', (event) => { /* … */ })
```

Omit `httpBaseUrl`/`bootstrapToken` (or pass a `webSocketTokenProvider`) to control
authentication yourself.

## Node

`@hive/client/node` adds backend discovery (port-range scan of the running desktop
app), deterministic instance selection, bootstrap-token resolution
(`$HIVE_DESKTOP_BOOTSTRAP_TOKEN` / the instance's `cli.json` / the app's argv) and a
one-call connected client — the logic the vendored `hive-ticket` CLI performs.

```ts
import { createNodeHiveClient } from '@hive/client/node'

const { client, backend } = await createNodeHiveClient({ instance: 'my-worktree' })
const projects = await client.request('db.project.getAll', {})
client.close()
```

> Keep `src/protocol.ts` in sync with `src/shared/rpc/protocol.ts` in the app repo —
> the types are vendored here to stay dependency-free.
