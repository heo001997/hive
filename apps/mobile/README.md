# Hive Mobile

A thin **remote** client for a self-hosted Hive backend, built with **Expo (managed) + React Native + TypeScript**. It drives Hive over the **same WS JSON-RPC backend** as the desktop app and the `hive` CLI, via the shared [`@hive/client`](../../packages/hive-client) SDK (Decision B).

It is intentionally **remote-only**: there is **no terminal / pty and no editor**. You browse projects → worktrees → sessions, watch a session's assistant stream live, send prompts, approve plans / answer permission prompts, and review diffs read-only.

## What it does

| Screen | RPC used |
| --- | --- |
| **Login** | `exchangeOwnerToken` (owner-token handshake) |
| **Session list** | `db.project.getAll`, `db.worktree.getByProject`, `db.session.getByWorktree` |
| **Session detail** | `db.session.get`, `db.worktree.get`, `opencodeOps.connect` (if needed), `opencodeOps.getMessages`, `opencodeOps.prompt`, `opencodeOps.planApprove` / `planReject`, `opencodeOps.permissionList` / `permissionReply`; live via the `opencode:stream` subscription |
| **Diff view** | `gitOps.getDiffStat`, `gitOps.getDiff` |
| **Push** | `push.register` (implemented by the backend) |

## Prerequisites

- **Node ≥ 22** and **pnpm** (this is a pnpm workspace).
- A running, reachable **Hive backend** with **owner authentication enabled** (it must accept `POST /api/auth/owner-exchange`). You need its URL (e.g. `http://192.168.1.50:3773`) and an **owner token**.
- For on-device testing: the **Expo Go** app, or a dev build. Push notifications require a real device (simulators cannot receive remote push) and an EAS `projectId` (see below).
- The phone and the backend must be on the **same network** (or the backend reachable through a tunnel / VPN). `localhost` on the phone is the phone itself — use the server's LAN IP or hostname.

## Install & run

From the **repo root** (so pnpm links the `@hive/client` workspace package):

```bash
pnpm install
```

> If `@hive/client` fails to resolve, confirm `apps/*` is registered in the
> workspace (see "Workspace registration" below).

Then start Metro for the mobile app:

```bash
cd apps/mobile
pnpm start          # expo start   (press i / a, or scan the QR with Expo Go)
# pnpm start:clear  # if Metro caches a stale module graph
```

Alternatively, from the repo root: `pnpm --filter @hive/mobile start`.

## Connecting to your backend

1. Launch the app → **Login** screen.
2. **Server URL**: enter your backend's base URL, e.g. `http://192.168.1.50:3773`.
   - On launch the app fetches `GET /.well-known/hive/environment` to learn the authoritative `wss://…/ws` URL. If that endpoint isn't exposed, it derives `ws(s)://host:port/ws` from your URL.
3. **Owner token**: paste the durable owner token your backend was configured with.
4. **Connect** → the app validates the token, stores it, and opens the live socket.

The owner token is the **root secret**. It is stored only in the device keychain/keystore (`expo-secure-store`), sent only to `/api/auth/owner-exchange`, and never logged. The short-lived session token the SDK mints from it is cached in `AsyncStorage` and cleared automatically on auth failure. **Sign out** (top-right on the session list) wipes both.

## Push notifications

- The app requests notification permission, obtains an **Expo push token**, and sends it to the backend via the `push.register` RPC after sign-in.
- The backend maps `(owner → token)` and, when a session needs attention (e.g. a question / permission), sends a push whose `data` payload includes `{ "hiveSessionId": "…" }`. Tapping it deep-links straight into that session.
- **Foreground**: the app is already live over the WebSocket, so updates stream in real time. **Background/killed**: the push covers you.
- To get a real Expo push token you must set a valid **EAS `projectId`** in `app.json` under `expo.extra.eas.projectId` (replace the placeholder). Without it, push simply stays off and the app still works foreground-live.

## Configuration reference

- `app.json` → `expo.extra.eas.projectId`: your EAS project id (for push).
- `app.json` → `expo.scheme`: `hive` (deep-link scheme).
- Server URL + owner token are entered at runtime on the Login screen; nothing is hard-coded.

## Workspace registration (follow-up)

The repo's `pnpm-workspace.yaml` currently lists only `packages/*`. For `pnpm install` to link this app and resolve `@hive/client`, add `apps/*`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

This was intentionally **not** changed here (the task scoped edits to `apps/mobile/`). Add it before installing.

## Human verification (required)

This scaffold was written to be correct, typed, and install-ready, but was **not** run in this environment (no simulator, RN/Expo deps not installed). A human must:

1. Register `apps/*` in `pnpm-workspace.yaml`, then `pnpm install`.
2. `cd apps/mobile && pnpm start`, open in Expo Go or a dev build.
3. Sign in against a real owner-auth backend and exercise the flows.
4. Set an EAS `projectId` and test push on a physical device.
5. **Device/simulator runs and app-store submission are human steps** (EAS Build / `eas submit`).
