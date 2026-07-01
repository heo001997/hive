# Loop Review & Fix — two-stage condition gate

A **review** ticket can act as a *gate*: when its agent settles in Review, Hive runs a
two-stage check and decides what happens next automatically — pass, open a fix loop, or
stop for you. When it opens a fix loop, an agent creates the round's tickets itself via the
`hive-ticket` CLI, in the reviewed ticket's own worktree, so the whole chain stays on one
branch = one PR.

This replaces nothing you already do by hand — it only kicks in on tickets you seed as a
gate, and it's **off by default**.

---

## The two stages

When a gated review ticket settles in Review, `onStrictVerifySettled` runs:

1. **Stage 1 — Strict Verify Reviewer ("did the agent finish its job?")**
   The existing completion check. On a gate ticket it runs with `isGate = true`, so a
   `needsInput` signal ("agent is waiting on the user") does **not** bounce the ticket back
   — it falls through to Stage 2 instead. Stage 1 judges *task completion*, not code
   quality, so a review that found blocking problems still passes Stage 1.

2. **Stage 2 — Routing LLM ("given the findings, what next?")**
   Only reached after Stage 1 passes. A second LLM reads the **tail of the review agent's
   transcript** (its findings/return) and returns a JSON verdict. It **trusts the
   transcript** — it does not re-run or re-judge the review. Routes:

   | Verdict | What happens |
   |---|---|
   | `pass` | Work is clean. Ticket **stays in Review** for you (or advances to Done if you enabled auto-done). |
   | `fix` | Concrete, agent-fixable issues found. Opens the next **fix round** (see below), up to the cap. |
   | `needs-human` | Ambiguous / needs a decision / a question is being asked. Left in Review + a `question` notification (Telegram). |

   No fail-open: an unreadable transcript, an eval error, an unknown verdict, or hitting the
   round cap all route to **blocked-for-you** (left in Review, `lifecycleStuck`, notified) —
   never a silent pass.

---

## The fix loop

On a `fix` verdict, Hive launches a Claude Code CLI step **in the reviewed ticket's own
worktree**. Its only job is to create the round's three linked tickets — it does **not**
fix anything itself:

```
fix-rR  →  review-plan-rR  →  review-rR   (gate)
```

- `fix-rR` — carries the Stage-2 `reason` + `fixes[]` folded into its description. Its own
  agent does the actual fixing when it launches.
- `review-plan-rR` — depends on `fix-rR`.
- `review-rR` — depends on `review-plan-rR`, and is **seeded as a gate itself** (`gate:
  true`), so when it settles the two-stage check runs again and the loop can continue.

All three thread the **same `worktree_id`** as the reviewed ticket — one worktree = one
branch = one PR across the whole chain and every round.

The agent gets the exact batch JSON pre-built and embedded in its prompt (Hive builds it,
the agent doesn't compose it), writes it to `round-R.json`, and runs:

```bash
node "$HIVE_TICKET_CLI" batch round-R.json
```

### Round cap

The round is parsed from the review ticket's **title** — loop tickets carry `(round R)`
(e.g. `Review (gate, round 3) — 2611`); the base review has none → round 0. When
`round ≥ Max fix rounds`, a further `fix` verdict is blocked for you instead of looping.
Default cap **3**.

---

## How to turn it on

### 1. Enable the gate (global default)

**Settings → General → "Condition Gate (two-stage review)"** (off by default). When on, it
seeds the gate config onto **new `review` drafts** created through the Board Assistant. Sub-
options (only shown when enabled):

| Setting | Default | Meaning |
|---|---|---|
| **Max fix rounds** | `3` | Fix loops before a review is left blocked for you (1–20). |
| **Routing AI provider** | Claude Code CLI | Which CLI reads the findings and picks the branch (Stage 2). |
| **Model** | provider default | Optional model id for the router. Blank = default. |
| **Auto-advance to Done on a pass** | off | On a `pass`, advance a chain ticket to Done (so the next auto-starts) instead of leaving it in Review. |
| **Routing prompt** | built-in | The Stage-2 system prompt. **Must** keep asking for the `verdict` / `reason` / `fixes` JSON or the gate can't parse. Has a "Reset to default". |

### 2. What counts as a gate ticket

A draft is seeded as a gate when the toggle is on **and** it's the review step:

- `draftKey` matches `/^review(-r\d+)?$/i` — i.e. `review`, `review-r1`, `review-r12`, …
  (`review-plan` is deliberately **not** a gate.)
- or its description references `/speckit-review` (for drafts whose key degraded to
  `draft-N`).

Gate chains are forced into **Build mode** (the settle/verify machinery requires it).

You can also author an `evaluate` action by hand on any ticket via the **Lifecycle
Callbacks editor** on the card — that's the generic form; the review-draft seeding above is
just the common instance.

---

## The `hive-ticket` CLI (used by the fix loop)

Lives at `~/.claude/skills/hive-create-ticket/create.mjs` (override with `HIVE_TICKET_CLI`).
Full-CRUD thin wrappers over the existing kanban RPCs:

```
hive-ticket create | list | get | update | move | delete | dep add|remove | batch
```

When Hive launches an agent it **auto-injects** the connection env, so the CLI needs zero
connection flags:

| Env var | What |
|---|---|
| `HIVE_HOST`, `HIVE_PORT` | the live local backend |
| `HIVE_DESKTOP_BOOTSTRAP_TOKEN` | auth (no port scan / token discovery needed) |
| `HIVE_DATA_DIR` | this instance's data dir |
| `HIVE_PROJECT_ID` | current project (default for `--project`) |
| `HIVE_WORKTREE_ID` | current worktree (default for `--worktree`) |
| `HIVE_TICKET_CLI` | resolved CLI entry path |

From any agent shell inside Hive you can just run e.g. `node "$HIVE_TICKET_CLI" list` and it
targets the right instance, pre-authed. The token is cleared on backend stop so a stale one
is never handed to a CLI.

---

## Walkthrough (dev)

1. Turn on **Condition Gate** in Settings. Leave Max fix rounds at 3.
2. Create a chain via the Board Assistant ending in a `review` ticket (Build mode). The
   `review` draft is seeded as a gate.
3. Let the chain run. When the review agent finishes and the ticket settles in Review:
   - **Stage 1** confirms the review ran (a `needsInput` won't bounce it).
   - **Stage 2** reads the review's findings.
4. Force each branch to see the routing:
   - **clean review** → `pass` → stays in Review for you (or Done if auto-done is on).
   - **review that lists concrete bugs** → `fix` → an agent opens `fix-r1 → review-plan-r1
     → review-r1` in the **same worktree**; the loop re-enters when `review-r1` settles.
   - **ambiguous / a question** → `needs-human` → left in Review + Telegram `question`, no
     bounce.
5. Drive three `fix` rounds to hit the cap → the 4th `fix` is **blocked for you** (left in
   Review, notified) instead of looping.

---

## Notes / guarantees

- **Trust model:** Stage 2 trusts the review agent's transcript 100% — same contract as
  Strict Verify. There are no independent "is this really fixed?" checks.
- **No fail-open:** every error / ambiguity / cap path leaves the ticket in Review and
  notifies you; it never fakes a pass.
- **One PR per chain:** every round reuses the reviewed ticket's worktree — one branch, one
  PR, however many rounds run.
- **Scope:** the fix loop is **agent-driven only** (the agent CRUDs the tickets via the
  CLI); Hive does not build the triple itself.
