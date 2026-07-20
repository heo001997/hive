# Hive Multi-Interface Architecture — Implementation Plan

**CLI · MCP · Web · Mobile — from one backend, one contract.**

> Status baseline: branch rebased to `main` @ `#140`, DB schema **v40**, 34 RPC domains.
> This is a living plan. Each phase is independently shippable; check items off as you go.

---

## 0. How to use this document

- Read §1–§4 once for the mental model. They rarely change.
- §5 is the **decision gate** — two decisions must be locked *before* any remote-facing code.
- §6 is the work, split into **phases**. Each phase has: Goal · Unblocks · Prereqs · Tasks (with file anchors) · Acceptance · Risks.
- Phases are ordered by dependency (§7). Do them in order unless the dependency graph says they can run in parallel.
- Every task cites the real file it touches so it can be picked up cold.

---

## 1. Thesis

The expensive architectural move is **already done**. Hive is no longer an Electron monolith: all business logic lives in a standalone Node HTTP+WebSocket server (`src/server/`) behind a transport-agnostic JSON-RPC contract, and the React UI already runs over either Electron-IPC **or** WebSocket from the same code.

Therefore "support web + mobile + a CLI for AI agents" is **not a rewrite**. It is:

1. Extract the client so anything can speak the contract.
2. Add new thin clients (CLI, MCP, mobile).
3. Add the **remote foundation** (identity, tenancy, TLS, resumable streams) that desktop never needed because it runs on loopback.

---

## 2. Current architecture (verified as-is)

```
Clients (React 18 + Zustand + Tailwind)         ← same bundle, desktop & web
        │
        ▼  transport resolved at runtime (src/renderer/src/api/environment.ts)
   ┌─────────────────────────────────────────┐
   │  window.desktopBridge (Electron preload) │  desktop
   │  WebSocket ws://  (browser)              │  web
   └─────────────────────────────────────────┘
        │  JSON-RPC request/response + pub-sub events · Zod-validated
        ▼
   src/server/  — standalone Node process (HIVE_HEADLESS=1 drops Electron)
     • raw http.createServer + custom RFC-6455 WebSocket (no Express/Hono/tRPC)
     • rpc/router.ts → 34 domain handlers
     • events/event-bus.ts (in-process pub/sub)
     • auth/: bootstrap token → access token → ws token
        │
        ▼  Node IPC "desktop commands" (109 typed) — only for Electron-native ops
   Domain services & side-effects
     • AgentSdkManager → Claude Code / Codex / OpenCode
     • simple-git + git worktree      • node-pty + ghostty (native ObjC)
     • chokidar file watch            • better-sqlite3 (schema v40, raw SQL)
     • Effect-TS islands (typed errors) + Zod 4 boundaries
        ┊
        ┄ external: hive-enterprise (GraphQL cloud, separate repo) + OAuth login
```

### Stack

| Layer | Tech | Notes |
|---|---|---|
| Shell | Electron 41, electron-builder | UI host + server launcher |
| UI | React 18, Zustand 5, Tailwind 4, Vite 6 | No router; layout nav via store state |
| Transport | `ws` 8.21, JSON-RPC, Zod 4 | Custom; not Express/Hono/tRPC/gRPC |
| Backend | Node raw `http`, `src/server/` | 34 RPC domains; `HIVE_HEADLESS=1` = no Electron |
| Errors | Effect-TS 3.18 | Discriminated-union errors at edges |
| Data | better-sqlite3 12, schema v40 | Raw SQL, single file; `hive-paths.ts` resolves location |
| Agents | claude-agent-sdk 0.3, codex app-server, opencode-sdk | Behind `AgentSdkManager`; OpenCode currently stub |
| Terminal | node-pty 1.1, xterm 6, ghostty (native) | PTY in backend, xterm in UI, bytes over RPC |
| Git | simple-git 3.30 + `git worktree` | Core feature: branch-per-session |
| Cloud | hive-enterprise GraphQL | Separate repo; renderer has generated client |

### Key file anchors

| Concern | Path |
|---|---|
| Server entry / HTTP+WS | `src/server/bin.ts`, `src/server/server.ts` |
| Server config / flags | `src/server/config.ts` |
| Auth | `src/server/auth/bootstrap.ts`, `src/server/auth/session.ts` |
| RPC router / domains | `src/server/rpc/router.ts`, `src/server/rpc/domains/*.ts` |
| Event bus | `src/server/events/event-bus.ts` |
| Client (to extract) | `src/renderer/src/api/hive-client.ts`, `ws-transport.ts`, `environment.ts`, `rpc-client.ts` |
| DB | `src/main/db/schema.ts` (v40), `database.ts`, `types.ts` |
| Agent SDKs | `src/main/services/agent-sdk-manager*.ts`, `claude-code-implementer.ts`, `codex-implementer.ts` |
| Terminal / git | `src/main/services/pty-service.ts`, `git-service.ts`, `hive-paths.ts` |
| CLI template | `resources/cli/hive-ticket.mjs` |
| Web build | `vite.web.config.ts` → `out/renderer-web` |

### What already works vs. what's missing

| | State |
|---|---|
| Standalone server, headless mode | ✅ works |
| Transport abstraction (IPC / WS) | ✅ works |
| Web static build + serving | ✅ wired, not hosted |
| Reconnect in ws-transport | ✅ exists (250ms), **no event replay** |
| `hive-ticket` CLI (kanban CRUD) | ✅ shipped (`resources/cli/hive-ticket.mjs`) — the pattern template |
| Full `hive` orchestration CLI | ❌ none (no `bin` in package.json) |
| `@hive/client` package | ❌ none (client embedded in renderer) |
| Hive-as-MCP-server | ❌ none (only Codex's *consumer* MCP schemas) |
| Server identity / user accounts | ❌ bootstrap token only, in-memory sessions |
| Multi-tenancy / data isolation | ❌ zero user scoping in `src/server/` |
| TLS / `wss://` | ❌ plain http/ws |
| Kanban RPC (web) | ◐ ~10 methods `Effect.die("not implemented")` in `kanban.ts` |
| Mobile app | ❌ none |

---

## 3. Target architecture

```
                 Hive Core Server  (unchanged contract, + remote foundation)
                 JSON-RPC + pub/sub · 34 domains · SQLite · AgentSdkManager
                 git / pty / fs · auth + identity + MULTI-TENANT
                                   │
        ┌──────────────┬───────────┴───────────┬──────────────┬──────────────┐
        ▼              ▼                        ▼              ▼              ▼
   Desktop         Web                     Mobile           CLI            MCP server
  (Electron)   (static React        (React Native,      (`hive`)      (AI agents drive
   ships ✅      + WS) ◐             thin remote) ❌      new ❌          Hive) new ❌
        └──────────────┴────────── all import @hive/client ──────┴──────────────┘
                              (one contract, one client SDK)
```

Every surface is a thin client of the **same** contract. Native pieces (pty, ghostty, git worktrees) **never** ship to a client — they stay in the backend, always running on a real machine.

---

## 4. Guiding principles (do not violate)

1. **One contract.** WS JSON-RPC + Zod is the core protocol for every client. Do not add a second parallel protocol (see §5 decision on GraphQL).
2. **Thin clients.** Clients render and call RPC. No git/pty/fs/agent logic leaks into a client.
3. **Effect + Zod at boundaries.** New backend code uses the existing Effect error style and Zod-validates every RPC edge. No new error paradigm.
4. **Multi-SDK stays behind `AgentSdkManager`.** New agents register there; nothing else changes.
5. **Backend runs on a real machine.** Web/mobile are windows onto it, never hosts of native capability.
6. **Security is not a later phase.** The backend exposes `bash`/`terminal`/`git`/`file` — that is remote code execution. It may not face the network until identity + tenancy + the machine-isolation decision are in place (§5, §6.3).

---

## 5. Decisions to lock BEFORE remote-facing work

### Decision A — Where does the backend run? (sizes everything)

pty + ghostty + git worktrees need a real machine; never the phone/browser. Pick one (or a supported subset):

| Model | UX | Cost / risk |
|---|---|---|
| **Self-host** — user runs backend on own dev box/VM; clients connect in | Good | Lowest; punts hosting to user; still needs identity+TLS |
| **Hosted runners** — you operate the machines (SaaS) | Best | Highest; full sandboxing, quotas, isolation, on-call |
| **Teleport-style remote attach** — backend lives where code is; clients are pure windows | Best for existing users | Needs Teleport v2 (§6.5) |

> **Recommendation:** ship **self-host first** (unblocks web fastest, minimal ops), design tenancy so **hosted runners** can layer on later, and treat **Teleport v2** as the bridge that makes mobile genuinely useful.

### Decision B — Mobile transport

| Option | Verdict |
|---|---|
| **(A)** Reuse WS JSON-RPC — mobile imports `@hive/client` | ✅ Recommended. One contract, no drift, least work. |
| **(B)** Separate GraphQL API (per older docs/plans) | Only if mobile needs a fundamentally different cache-friendly read model. Doubles maintenance + auth surface. |

> **Recommendation:** **(A).** Keep GraphQL, if at all, only as a thin optional *read* gateway in `hive-enterprise` for org-dashboard/fan-out — never for core session/terminal/git ops (inherently streaming, already modeled as RPC + events).

**Do not start Phase 5 (mobile) or Phase 4 hosted variants until A and B are recorded here.**

- [x] **Decision A recorded: SELF-HOST FIRST.** Each user runs their own backend; web + mobile connect in. No multi-tenant / no 34-domain tenancy rewrite. Remote foundation = auth-for-remote + TLS/wss + resumable subscriptions + backend-as-service. Hosted-SaaS can layer on later. _(locked 2026-07-20)_
- [x] **Decision B recorded: REUSE WS JSON-RPC.** Mobile imports `@hive/client`; no separate GraphQL core. _(locked 2026-07-20)_
- [x] **Scope: BUILD EVERYTHING** — incl. full React Native app + push notifications + Teleport v2 remote-attach.

> Because Decision A = self-host, Phase 3's multi-tenancy (§6.3.2) is **descoped** to single-owner: keep one owner per backend, add remote auth + isolation-of-transport (TLS) + resumable streams; skip per-user row scoping across the 34 domains.

---

## 6. Phases

Legend: effort ≈ S (days) · M (1–2 wk) · L (multi-wk) · XL (month+).

---

### Phase 0 — Extract `@hive/client` (the keystone)

**Goal.** A platform-neutral package that speaks the Hive contract, importable by renderer, CLI, MCP, and React Native.

**Unblocks.** Every other phase (1, 2, 5 directly; 4 indirectly).

**Prereqs.** None.

**Tasks.**
- [ ] Create `packages/hive-client/` (new pnpm workspace package). Add workspace config to `package.json` / `pnpm-workspace.yaml`.
- [ ] Move & de-DOM: `src/renderer/src/api/ws-transport.ts` + `hive-client.ts` → package. Remove any `window`/DOM assumptions.
- [ ] Abstract **token storage** behind an interface (`TokenStore`): browser `localStorage`, RN `AsyncStorage`, CLI/MCP in-memory or file. Default impls per platform.
- [ ] Abstract **config/env resolution**: today `environment.ts` reads `window.desktopBridge` / `VITE_*` / `window.location`. Turn into an injected `ClientConfig` (baseUrl, token, WebSocket impl).
- [ ] Inject the **WebSocket implementation** (browser global / `ws` / RN global) rather than importing one.
- [ ] Fold in **backend discovery + handshake** currently duplicated in `resources/cli/hive-ticket.mjs` (port scan 3773–3873, `POST /api/auth/bootstrap` → `POST /api/auth/ws-token` → `ws://…/ws?token=`). Single source of truth.
- [ ] Ship generated/typed method signatures for the 34 domains (derive from the Zod schemas already in `src/server/rpc`).
- [ ] Repoint `src/renderer` to import from `@hive/client`. **No behavior change** — this is a refactor.

**Acceptance.** Desktop app runs unchanged using `@hive/client`. Package builds with zero `window`/Electron references. A trivial Node script can `import { HiveClient }`, connect, and call one RPC.

**Effort.** M. **Risks.** Hidden DOM coupling in the transport; token-storage lifecycle differences across platforms.

---

### Phase 1 — Full `hive` CLI

**Goal.** A scriptable command-line client covering worktree/session/git — not just tickets.

**Unblocks.** Phase 2 (MCP wraps the same ops). Immediate value for scripting/CI.

**Prereqs.** Phase 0.

**Tasks.**
- [ ] New CLI entry (reuse the dependency-free style of `resources/cli/hive-ticket.mjs`) built on `@hive/client`.
- [ ] Add `bin` field to `package.json` (`"hive": "./resources/cli/hive.mjs"` or a built entry). None exists today.
- [ ] Commands mirroring RPC domains:
  - `hive worktree create|list|remove|duplicate`
  - `hive session start --sdk claude|codex|opencode` · `session prompt` · `session logs --follow` · `session approve`
  - `hive git status|diff|…` · `hive project list`
- [ ] `--json` / NDJSON output mode for machine parsing (agents, CI).
- [ ] Backend selection: reuse discovery (`--port`/`HIVE_PORT`, dataDir/repoRoot matching) from the ticket CLI.
- [ ] Auth: works with a running desktop backend (bootstrap discovery) **and** a headless one (bearer token from Phase 3).
- [ ] Preserve/absorb existing `hive-ticket` commands (don't regress `resources/cli/hive-ticket.mjs`).

**Acceptance.** From a terminal, with Hive running: create a worktree, start a Claude session, stream its output, all via `hive …`, output parseable with `--json`.

**Effort.** M. **Risks.** Streaming ergonomics over a CLI; long-lived subscriptions vs. process exit.

---

### Phase 2 — Hive-as-MCP-server (AI agents drive Hive)

**Goal.** Expose Hive operations as MCP tools so any agent (Claude Code, etc.) can orchestrate worktrees/sessions as tool calls. **This is the ticket's core ask.**

**Unblocks.** Agent-driven Hive workflows.

**Prereqs.** Phase 0; shares command surface with Phase 1.

**Tasks.**
- [ ] New MCP server process using `@modelcontextprotocol/sdk`, built on `@hive/client`. (Note: only Codex *consumer* MCP schemas exist today — this is Hive as a *provider*.)
- [ ] Map a curated safe subset of RPC ops to MCP tools: `hive.worktree.create`, `hive.session.start`, `hive.session.prompt`, `hive.session.await`, `hive.git.status`, etc.
- [ ] Streaming/await semantics: a tool call that starts a session must be able to block-until-idle or poll (agents need a completion signal).
- [ ] **Headless auth**: device-code or bearer token (no browser bootstrap) — depends on Phase 3 auth for remote; local can reuse discovery.
- [ ] Ship a registration snippet (`.mcp.json` / Claude Code config) so users can add the Hive MCP server.
- [ ] Guardrails: which tools are exposed by default; destructive ops (delete worktree) gated/opt-in.

**Acceptance.** Add the Hive MCP server to an agent; the agent creates a worktree, launches a session, and reads results entirely through tool calls.

**Effort.** M. **Risks.** Tool granularity (too fine = chatty, too coarse = opaque); giving an agent destructive powers.

---

### Phase 3 — Remote foundation (the web + mobile enabler)

**Goal.** Everything the backend needs to safely face a network. Desktop never needed this; web and mobile cannot exist without it.

**Unblocks.** Phases 4, 5, and remote/hosted variants of 1 & 2.

**Prereqs.** Decision A (§5).

> **Security gate.** The backend intentionally offers `bash`/`terminal`/`git`/`file` — remote code execution by design. It must not accept non-loopback connections until §6.3.1–§6.3.3 land and the machine-isolation model (Decision A) is chosen. Track this as a hard release blocker.

**Tasks — Identity (3.1).**
- [ ] Real login into the server. Wire the existing hive-enterprise OAuth (`src/renderer/src/api/hive-enterprise/`) into `src/server/auth/` — today OAuth is renderer-only and **not** connected to server auth.
- [ ] Persistent user records (new table, schema bump from v40). Access/ws tokens currently in-memory (`src/server/auth/session.ts`) — back them with durable sessions.
- [ ] Bearer / device-code flow for headless clients (CLI, MCP, mobile) — no local bootstrap file available off-machine.

**Tasks — Multi-tenancy / isolation (3.2).**
- [ ] Add ownership scoping (`user_id` or per-user DB) across the schema; migrate existing single-user data.
- [ ] Enforce scoping on **every** RPC domain in `src/server/rpc/domains/*.ts` (34 files) — no cross-user reads/writes.
- [ ] Path-traversal hardening on `file-ops`/`file-tree-ops`; command sandboxing/policy on `bash`/`terminal`.
- [ ] Per-operation authorization checks (not just "is authenticated").

**Tasks — Transport & service (3.3).**
- [ ] TLS: add `https`/`wss` support to `src/server/server.ts` (currently plain `http`) **or** document a mandated reverse proxy. `BIND_IP` already requires `REQUIRE_AUTH=true` — extend that guard to require TLS off-loopback.
- [ ] Backend as a supervised, standalone service (not spawned-by-Electron). Harden `HIVE_HEADLESS=1` path: lifecycle, restart, health (`/health` exists), graceful shutdown. Extend `Dockerfile`.

**Tasks — Reliability (3.4).**
- [ ] Resumable subscriptions: add sequence/cursor to `events/event-bus.ts` and replay-on-reconnect to `ws-transport.ts` (reconnect exists; **replay does not** — events during a drop are lost).

**Acceptance.** A second machine authenticates as a distinct user over `wss://`, sees only its own data, survives a dropped connection without losing agent output, and cannot touch another user's files or shells.

**Effort.** XL (3.2 alone is L–XL). **Risks.** Tenancy is invasive across 34 domains + schema; the security surface is the project's highest.

---

### Phase 4 — Web productization

**Goal.** A hosted (self-host first) web Hive.

**Unblocks.** Browser users; a base for hosted SaaS later.

**Prereqs.** Phase 3 (identity + tenancy + TLS). Phase 0 helps but web already runs on the embedded client.

**Tasks.**
- [ ] Finish the ~10 stubbed kanban RPC methods in `src/server/rpc/domains/kanban.ts` (`getColumnPages`, `getColumnPage`, `moveToProject`, `reorder`, `reorderBatch`, `getBySession`, `addTokens`, `syncPR`, `clearPR`, `attachPR`).
- [ ] Serve the static build (`build:web` → `out/renderer-web`) from the server with correct CORS/CSP for real origins.
- [ ] Renderer reload resilience (browser refresh ≠ Electron): rehydrate state from server, not from an assumed-persistent process.
- [ ] Presentation/logic split (see Phase 5 task) as needed so web doesn't depend on Electron-only bridge paths.
- [ ] Deploy recipe (container + reverse proxy + TLS) documented and tested.

**Acceptance.** A browser on another machine logs in over HTTPS, drives full sessions + kanban, and reload doesn't lose state.

**Effort.** M–L. **Risks.** Feature gaps where the UI assumed desktop capabilities (native editor/terminal affordances).

---

### Phase 5 — Teleport v2 (live remote backend)

**Goal.** Turn one-way SSH session handoff (Teleport v1) into a persistent remote backend that clients stream from.

**Unblocks.** Genuinely useful mobile; "code on my dev box from anywhere."

**Prereqs.** Phase 3.

**Tasks.**
- [ ] Extend `src/server/rpc/domains/teleport-ops.ts` from handoff to a persistent attach model.
- [ ] Client can list & connect to remote backends (my laptop / my VM) through `@hive/client`.
- [ ] Reconciliation of session/worktree state when reattaching.

**Acceptance.** A thin client attaches to a backend running on a different machine and drives a live session as if local.

**Effort.** L. **Risks.** State reconciliation; network partitions mid-session.

---

### Phase 6 — Mobile app (React Native)

**Goal.** A read / approve / chat mobile client. No pty/terminal/native editor on device.

**Unblocks.** Mobile users.

**Prereqs.** Decision B; Phase 0; Phase 3; Phase 5 (for the remote-backend UX).

**Tasks.**
- [ ] React Native app importing `@hive/client` (RN WebSocket + `AsyncStorage` token store from Phase 0).
- [ ] **Presentation/logic split** in `src/renderer`: factor Zustand stores, API facades, and shared types out of React-DOM components so RN reuses logic (it cannot reuse DOM components).
- [ ] Scoped UI: session list, message/chat stream, diff view (read), plan approval, needs-input responses. Explicitly exclude terminal/pty and heavy editors.
- [ ] Push notifications (APNS/FCM) for needs-input / plan-ready / PR-merged. Reuse the notification trigger pattern from `src/server/rpc/domains/telegram-ops.ts`; add a push transport + backend hooks.
- [ ] Poor-network / offline handling (depends on Phase 3.4 resumable subscriptions).

**Acceptance.** On a phone, connect to a remote backend, watch a live session, approve a plan, answer a needs-input prompt, and receive a push when the session needs attention.

**Effort.** XL. **Risks.** UI reimplementation cost; mobile background/network constraints; push infra ops.

---

## 7. Dependency graph & ordering

```
                    ┌─────────────────────────────┐
Decision A, B ─────►│  §5 must be locked first     │
                    └─────────────────────────────┘
Phase 0 (@hive/client) ──┬──► Phase 1 (CLI) ──► Phase 2 (MCP)
                         │
                         └──► (used by) Phase 6 (Mobile)

Phase 3 (Remote foundation) ──┬──► Phase 4 (Web)
                              ├──► Phase 5 (Teleport v2) ──► Phase 6 (Mobile)
                              └──► remote/hosted variants of Phase 1 & 2
```

**Recommended sequence**

1. **§5 decisions** (hours, but blocking).
2. **Phase 0** — keystone.
3. **Phase 1 + Phase 2** — highest leverage, low risk, local-only, no security exposure. Ship agent value early.
4. **Phase 3** — the big lift; start 3.1/3.2/3.3 in parallel.
5. **Phase 4** — web on self-host as soon as Phase 3 allows.
6. **Phase 5**, then **Phase 6**.

Phases 1–2 deliver the ticket's core ask ("AI agent uses Hive via CLI") **before** the heavy Phase 3 investment.

---

## 8. Cross-cutting concerns

- **Security** (owns Phase 3 gate): every network-exposed op needs authz; `bash`/`terminal`/`file`/`git` are RCE by design; path traversal + command policy; secret handling for tokens.
- **DB migrations**: schema is v40, raw SQL, versioned in `src/main/db/schema.ts`. Tenancy (3.2) and identity (3.1) each need a migration; coordinate numbering (see fork-sync note — migrations get renumbered on rebase).
- **Testing**: DB suites skip locally (better-sqlite3 native unavailable in vitest), run in CI. Git-effect tests must stub `HIVE_WORKTREES_DIR`. Add contract tests for `@hive/client` against a headless server; e2e via the existing Playwright harness.
- **Observability**: renderer/hook status transitions are not logged to file today (known gap) — add structured logging as remote surfaces multiply.
- **Backpressure/perf**: terminal output coalescing already exists (`terminal-output-coalescer.ts`); verify it holds over remote links.

---

## 9. Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Multi-tenancy invasive across 34 domains + schema | 3.2 | Central scoping helper; migrate before exposing; per-domain review |
| RCE exposure to network | 3 | Hard release gate; authz per op; sandbox `bash`/`terminal` |
| Two contracts (GraphQL + JSON-RPC) drift | Dec. B | Lock (A): one contract; GraphQL read-only gateway at most |
| Native pieces pulled toward clients | all | Principle #5; code review; clients import only `@hive/client` |
| Lost stream on flaky mobile link | 3.4/6 | Resumable subscriptions with cursor + backfill |
| Hidden DOM coupling blocks extraction | 0 | Inject WebSocket/storage/config; CI check for `window` refs |
| UI assumed desktop capability | 4/6 | Capability flags per surface; scope mobile to read/approve/chat |

---

## 10. Glossary

- **`@hive/client`** — the extracted, platform-neutral JSON-RPC-over-WS client SDK (Phase 0).
- **Contract** — the WS JSON-RPC method set + Zod schemas exposed by `src/server/rpc`.
- **Thin client** — a surface that only renders + calls RPC; holds no native capability.
- **Remote foundation** — identity + tenancy + TLS + resumable streams (Phase 3).
- **Teleport** — moving/attaching a session to a backend on another machine (v1 SSH handoff → v2 live attach).

---

*Generated from a read-only architecture sweep of the codebase at `main` @ `#140`. No application code changed by this document.*
