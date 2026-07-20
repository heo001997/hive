/**
 * Pure, side-effect-free helpers for the two-stage Condition Gate. Moved to
 * `src/shared/` so BOTH the renderer (per-ticket UI + store) and the server/main
 * process (the create-RPC auto-arm seeding — no server file may import
 * `renderer/src/lib/ticket-lifecycle.ts`) share ONE definition of "what marks a
 * gate ticket" and "how the gate routes a verdict".
 *
 * `src/renderer/src/lib/ticket-lifecycle.ts` re-exports everything here so the
 * existing renderer imports keep working untouched.
 */
import type {
  LifecycleAction,
  LifecycleStateConfig,
  TicketLifecycleConfig
} from '@shared/types/ticket-lifecycle'

/**
 * Config carried by an `evaluate` (condition-gate) action. All fields optional —
 * the store falls back to the global settings for anything unset. Stored inside a
 * `review.during` action's `config` (a `Record<string, unknown>`); read it back
 * with {@link conditionGateConfigOf}.
 */
export interface ConditionGateActionConfig {
  /**
   * Which gate engine runs after the Stage-1 frozen check:
   *   - `'judge'` (default, undefined) — the LLM review judge (`runConditionGate`):
   *     spawns a judge CLI, reads `review-gate.json`, routes pass/fix/needs-human.
   *   - `'shard'` — the DETERMINISTIC shard loop (`runShardGate`): runs {@link predicate}
   *     (a shell command that prints `DONE`/`CONTINUE`/`BLOCK`) and, on `CONTINUE`,
   *     spawns a numbered continuation ticket re-running {@link command} in the same
   *     worktree; on `DONE`, spawns the {@link next} phase. Used by the sharded
   *     `/speckit-e2e-{spec,execute,report}` phases that need N fresh-context runs
   *     (N unknown until the registry is written) to converge.
   */
  mode?: 'judge' | 'shard'
  /** Stage-2 LLM provider (falls back to the global condition-gate / Strict-Verify provider). */
  provider?: string
  /** Optional model override (falls back to the global condition-gate model). */
  model?: string
  /** Optional Stage-2 system-prompt override (falls back to the global default). */
  prompt?: string
  /**
   * Max loop rounds before the gate blocks for the human. Judge mode falls back to
   * the global cap (3); shard mode's fallback is generous (a 20-file execute needs
   * 20+ runs) — see `runShardGate`.
   */
  maxRounds?: number
  /** When true, a clean `pass` may auto-advance to Done; default false (leave in Review for the human). */
  autoDone?: boolean

  // ── shard-mode only (ignored by the judge path) ──────────────────────────────
  /**
   * SHARD: a shell command run in the ticket's worktree whose LAST whitespace-token
   * on stdout is the verdict — `DONE` (the phase's disk state is complete → advance),
   * `CONTINUE` (more shards remain → spawn the next numbered run), or `BLOCK`
   * (escalate). Authored to self-resolve `FEATURE_DIR` (via `resolve-e2e-context.sh`)
   * and grep the phase's on-disk completion marker (e.g. `grep -c PENDING …`).
   */
  predicate?: string
  /** SHARD: the slash command a `CONTINUE` re-launches in a fresh session (e.g. `/speckit-e2e-execute`). */
  command?: string
  /** SHARD: human phase label used in the numbered run titles (e.g. `E2E Execute`). */
  label?: string
  /** SHARD: draft-key base for the run tickets (e.g. `e2e-execute` → `e2e-execute-r2`). */
  key?: string
  /** SHARD: the next phase to spawn on `DONE`. Omit on the terminal phase (chain end). */
  next?: ShardNextSpec
}

/**
 * A fully self-describing spec for the NEXT sharded phase, carried inside a shard
 * gate's `config.next`. Because it recursively carries its OWN `next`, the whole
 * e2e tail (spec → execute → report) nests bottom-up in one config and the chain
 * self-extends: each phase, on `DONE`, materializes the next from this spec.
 */
export interface ShardNextSpec {
  command: string
  label: string
  key: string
  predicate: string
  maxRounds?: number
  /** The phase after this one, or omitted when this is the last phase. */
  next?: ShardNextSpec
}

/** Drop undefined/empty keys so the stored gate config stays minimal + equality-friendly. */
function cleanGateConfig(config: ConditionGateActionConfig): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined && v !== '') cleaned[k] = v
  }
  return cleaned
}

/**
 * The condition-GATE lifecycle config. A `DURING(review)` action of
 * `type: 'evaluate'` MARKS the review ticket as a two-stage gate; the engine
 * (`useKanbanStore.runConditionGate`) keys off it and reads its `config`. It has NO
 * `review.branches` fail→in_progress edge — the gate routes its own outcomes
 * (pass / fix / needs-human) after the Stage-1 Strict-Verify pass.
 */
export function buildConditionGateConfig(
  config: ConditionGateActionConfig = {}
): TicketLifecycleConfig {
  return {
    enabled: true,
    states: {
      review: {
        during: [{ id: 'condition-gate-evaluate', type: 'evaluate', config: cleanGateConfig(config) }]
      }
    }
  }
}

/** True when a config exists and is enabled (mirrors `isLifecycleEnabled`, inlined to stay dependency-free). */
function gateConfigEnabled(cfg?: TicketLifecycleConfig | null): boolean {
  return !!cfg && cfg.enabled === true
}

/** True when `cfg` marks a condition gate (a `DURING(review)` `evaluate` action). */
export function isConditionGate(cfg?: TicketLifecycleConfig | null): boolean {
  return (
    gateConfigEnabled(cfg) && (cfg?.states?.review?.during ?? []).some((a) => a.type === 'evaluate')
  )
}

/**
 * Extract the {@link ConditionGateActionConfig} from a gate ticket's config (the
 * first `review.during` `evaluate` action). Returns `{}` when there is none.
 */
export function conditionGateConfigOf(
  cfg?: TicketLifecycleConfig | null
): ConditionGateActionConfig {
  const action = (cfg?.states?.review?.during ?? []).find((a) => a.type === 'evaluate')
  const c = (action?.config ?? {}) as Record<string, unknown>
  return {
    mode: c.mode === 'shard' ? 'shard' : undefined,
    provider: typeof c.provider === 'string' ? c.provider : undefined,
    model: typeof c.model === 'string' ? c.model : undefined,
    prompt: typeof c.prompt === 'string' ? c.prompt : undefined,
    maxRounds:
      typeof c.maxRounds === 'number' && Number.isFinite(c.maxRounds) ? c.maxRounds : undefined,
    autoDone: c.autoDone === true,
    predicate: typeof c.predicate === 'string' ? c.predicate : undefined,
    command: typeof c.command === 'string' ? c.command : undefined,
    label: typeof c.label === 'string' ? c.label : undefined,
    key: typeof c.key === 'string' ? c.key : undefined,
    next: asShardNextSpec(c.next)
  }
}

/** Lenient parse of a stored `config.next` blob into a {@link ShardNextSpec} (undefined if it isn't one). */
function asShardNextSpec(value: unknown): ShardNextSpec | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v.command !== 'string' ||
    typeof v.label !== 'string' ||
    typeof v.key !== 'string' ||
    typeof v.predicate !== 'string'
  ) {
    return undefined
  }
  return {
    command: v.command,
    label: v.label,
    key: v.key,
    predicate: v.predicate,
    maxRounds:
      typeof v.maxRounds === 'number' && Number.isFinite(v.maxRounds) ? v.maxRounds : undefined,
    next: asShardNextSpec(v.next)
  }
}

/** True when `cfg` marks a SHARD gate (an `evaluate` action whose `config.mode === 'shard'`). */
export function isShardGate(cfg?: TicketLifecycleConfig | null): boolean {
  return isConditionGate(cfg) && conditionGateConfigOf(cfg).mode === 'shard'
}

/**
 * Build a SHARD gate lifecycle config from a {@link ShardNextSpec}. Used to
 * materialize the NEXT phase's gate when a shard advances (and by the scaffolder to
 * seed the first sharded phase). Carries `next` verbatim so the chain self-extends.
 */
export function buildShardGateConfig(spec: ShardNextSpec): TicketLifecycleConfig {
  return {
    enabled: true,
    states: {
      review: {
        during: [
          {
            id: 'shard-gate-evaluate',
            type: 'evaluate',
            config: cleanGateConfig({
              mode: 'shard',
              predicate: spec.predicate,
              command: spec.command,
              label: spec.label,
              key: spec.key,
              maxRounds: spec.maxRounds,
              next: spec.next
            })
          }
        ]
      }
    }
  }
}

/**
 * Toggle the condition gate on/off on a ticket's lifecycle config (Part B UI +
 * anywhere a single flip is wanted). Preserves any OTHER states/actions already
 * configured; only the `review.during` `evaluate` action is added or stripped.
 *   - `on: true`  → ensure exactly one gate `evaluate` action carrying `gateCfg`.
 *   - `on: false` → strip it; returns `null` when nothing meaningful is left, so a
 *                   plain ticket reverts to seed-from-global (a null config).
 */
export function setConditionGate(
  config: TicketLifecycleConfig | null | undefined,
  on: boolean,
  gateCfg: ConditionGateActionConfig = {}
): TicketLifecycleConfig | null {
  if (on) {
    const evaluateAction: LifecycleAction = {
      id: 'condition-gate-evaluate',
      type: 'evaluate',
      config: cleanGateConfig(gateCfg)
    }
    const states = config?.states ?? {}
    const review = states.review ?? {}
    // Replace any existing evaluate action (idempotent re-arm), keep other during actions.
    const during = [...(review.during ?? []).filter((a) => a.type !== 'evaluate'), evaluateAction]
    return {
      enabled: true,
      states: { ...states, review: { ...review, during } }
    }
  }

  // off: strip the evaluate action from review.during.
  if (!config?.states) return null
  const nextStates: TicketLifecycleConfig['states'] = { ...config.states }
  const review = nextStates.review
  if (review) {
    const during = (review.during ?? []).filter((a) => a.type !== 'evaluate')
    const nextReview: LifecycleStateConfig = { ...review }
    if (during.length) nextReview.during = during
    else delete nextReview.during
    if (Object.keys(nextReview).length === 0) delete nextStates.review
    else nextStates.review = nextReview
  }
  // Nothing left to configure → null so the ticket reverts to global seeding.
  if (Object.keys(nextStates).length === 0) return null
  return { ...config, enabled: config.enabled ?? true, states: nextStates }
}

/** Minimal draft shape the review-gate matcher needs (board-chat + parsed drafts both fit). */
export interface ReviewGateDraftLike {
  draftKey?: string
  description?: string | null
}

/**
 * How {@link isReviewGateDraft} decides a draft is the gate ticket:
 *   - `key`  — match the draftKey against the key pattern only,
 *   - `word` — match the description against the word pattern only,
 *   - `both` — match either (the default; preserves the original behavior).
 */
export type ConditionGateMatchMode = 'key' | 'word' | 'both'

/** Default gate matcher (key): draftKey `review` / `review-r{R}`, anchored so `review-plan` is rejected. */
export const DEFAULT_CONDITION_GATE_KEY_PATTERN = '^review(-r\\d+)?$'
/** Default gate matcher (word): a `/speckit-review` reference in the description, not `/speckit-review-plan`. */
export const DEFAULT_CONDITION_GATE_WORD_PATTERN = '/speckit-review(?![\\w-])'

/** Compiled defaults (exported so both the seeding path + tests can reference them). */
export const DEFAULT_GATE_KEY_RE = /^review(-r\d+)?$/i
export const DEFAULT_GATE_WORD_RE = /\/speckit-review(?![\w-])/i

/** User-tunable matcher config (from the Condition Gate settings). All optional → defaults. */
export interface GateMatchConfig {
  mode?: ConditionGateMatchMode
  /** Regex SOURCE tested (case-insensitively) against the draftKey. */
  keyPattern?: string
  /** Regex SOURCE tested (case-insensitively) against the description. */
  wordPattern?: string
}

/** Compile `source` as a case-insensitive regex; fall back to `fallback` on an empty/invalid pattern. */
export function safeGateRegex(source: string | undefined, fallback: RegExp): RegExp {
  const src = source?.trim()
  if (!src) return fallback
  try {
    return new RegExp(src, 'i')
  } catch {
    // A malformed user pattern must not break seeding — fall back to the default so
    // the gate keeps matching as before (the Settings hint warns about invalid regex).
    return fallback
  }
}

/**
 * True when a draft is the `review` step (the gate ticket of a chain or loop round)
 * — so the condition-gate config gets seeded onto it and not its siblings.
 *
 * With no `cfg` (or empty fields) it uses the built-in defaults: match by draftKey
 * (`review`, `review-r1`, `review-r12`, …) OR, since an omitted draftKey degrades to
 * `draft-N`, by a `/speckit-review` reference in the description. `review-plan` is
 * deliberately NOT a gate (the anchored key regex + the `(?![\w-])` word boundary both
 * reject it). `cfg` lets the user narrow to key-only / description-only and edit either
 * pattern; an invalid user pattern falls back to the corresponding default.
 */
export function isReviewGateDraft(draft: ReviewGateDraftLike, cfg?: GateMatchConfig): boolean {
  const mode = cfg?.mode ?? 'both'
  const key = draft.draftKey?.trim() ?? ''
  const desc = draft.description ?? ''
  const keyHit = mode !== 'word' && safeGateRegex(cfg?.keyPattern, DEFAULT_GATE_KEY_RE).test(key)
  const wordHit = mode !== 'key' && safeGateRegex(cfg?.wordPattern, DEFAULT_GATE_WORD_RE).test(desc)
  return keyHit || wordHit
}

/** The resolved gate settings the seeding path reads (mirrors the server-side settings shape). */
export interface ConditionGateSeedInput {
  /** Master switch — when false nothing is ever seeded. */
  enabled: boolean
  maxRounds: number
  provider: string
  /** Empty string = provider default (dropped to undefined before building the config). */
  model: string
  prompt: string
  autoDone: boolean
  matchMode?: ConditionGateMatchMode
  keyPattern?: string
  wordPattern?: string
}

/** The mutable slice of an incoming ticket/draft the seeding path reads + stamps. */
export interface ConditionGateSeedTarget {
  description?: string | null
  lifecycle_callbacks?: TicketLifecycleConfig | null
  lifecycle_state?: string | null
}

/**
 * Server-side auto-arm decision (Part A), extracted pure so it's testable without the
 * DB/native layer that `kanban.ts` pulls in. Mutates `target` in place; returns true
 * when it seeded a gate config. NEVER clobbers a caller-provided `lifecycle_callbacks`,
 * only acts when the gate is enabled AND the draft matches the review pattern.
 */
export function seedConditionGateOnTarget(
  target: ConditionGateSeedTarget,
  draftKey: string | undefined,
  gate: ConditionGateSeedInput
): boolean {
  // Never overwrite a config the caller already provided (Board-Chat path).
  if (target.lifecycle_callbacks) return false
  if (!gate.enabled) return false
  const matches = isReviewGateDraft(
    { draftKey, description: target.description ?? null },
    { mode: gate.matchMode, keyPattern: gate.keyPattern, wordPattern: gate.wordPattern }
  )
  if (!matches) return false
  target.lifecycle_callbacks = buildConditionGateConfig({
    maxRounds: gate.maxRounds,
    provider: gate.provider,
    model: gate.model || undefined,
    prompt: gate.prompt,
    autoDone: gate.autoDone
  })
  // Seed the confirmed lifecycle runtime state so the gate arms on first settle.
  target.lifecycle_state = 'todo'
  return true
}

/** What a condition gate does given a Stage-2 verdict + the current loop round. */
export type ConditionGateDecision =
  | { kind: 'pass' }
  | { kind: 'fix'; round: number }
  | { kind: 'block'; reason: string }

/**
 * Pure routing for the condition gate (Stage 2). Given the Stage-2 `verdict`, the
 * `currentRound` (0 for the base review, R for a `review-rR` loop ticket), and the
 * `maxRounds` cap:
 *   - `pass`        → `pass` (stop, wait for the human)
 *   - `needs-human` → `block` (leave in Review + notify)
 *   - `fix` under the cap → `fix` at `currentRound + 1` (open the next round)
 *   - `fix` at/over the cap → `block` (loop ran too deep — surface for the human)
 * Never fails open: an unknown verdict blocks.
 */
export function decideConditionGate(
  verdict: { verdict: string; reason?: string },
  currentRound: number,
  maxRounds: number
): ConditionGateDecision {
  if (verdict.verdict === 'pass') return { kind: 'pass' }
  if (verdict.verdict === 'fix') {
    if (currentRound >= maxRounds) {
      return {
        kind: 'block',
        reason: `fix-loop cap reached (round ${currentRound} ≥ max ${maxRounds})`
      }
    }
    return { kind: 'fix', round: currentRound + 1 }
  }
  // 'needs-human' and any unexpected value → block for the human (no fail-open).
  return { kind: 'block', reason: verdict.reason?.trim() || 'review needs a human decision' }
}

/** What a SHARD gate does given a predicate verdict + the current run number. */
export type ShardGateDecision =
  | { kind: 'advance' }
  | { kind: 'continue'; round: number }
  | { kind: 'block'; reason: string }

/** The shard predicate's three accepted verdicts (matched case-insensitively). */
export const SHARD_VERDICTS = ['DONE', 'CONTINUE', 'BLOCK'] as const

/**
 * Pure routing for the shard loop. `predicateOutput` is the raw stdout of the shard
 * predicate; the LAST RECOGNIZED verdict token (scanning from the end) is used, so a
 * predicate may echo diagnostics before AND after the verdict (e.g. `echo "DONE (0
 * pending)"`). `currentRound` is the run number parsed from the ticket title (0 for the
 * base phase ticket, R for a `(run R)` continuation).
 *   - `DONE`                 → `advance` (disk state complete — spawn the next phase)
 *   - `CONTINUE` under cap   → `continue` at `currentRound + 1` (spawn the next run)
 *   - `CONTINUE` at/over cap → `block` (loop ran too deep — surface for the human)
 *   - `BLOCK` / none found   → `block` (never fails open)
 */
export function decideShardGate(
  predicateOutput: string,
  currentRound: number,
  maxRounds: number
): ShardGateDecision {
  const tokens = (predicateOutput ?? '').trim().split(/\s+/).filter(Boolean)
  // Scan from the END for the last token that IS a recognized verdict — tolerates
  // trailing diagnostics/punctuation after a genuine DONE/CONTINUE instead of blocking.
  let verdict = ''
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase()
    if (t === 'DONE' || t === 'CONTINUE' || t === 'BLOCK') {
      verdict = t
      break
    }
  }
  if (verdict === 'DONE') return { kind: 'advance' }
  if (verdict === 'CONTINUE') {
    if (currentRound >= maxRounds) {
      return {
        kind: 'block',
        reason: `shard loop cap reached (run ${currentRound} ≥ max ${maxRounds})`
      }
    }
    return { kind: 'continue', round: currentRound + 1 }
  }
  if (verdict === 'BLOCK') {
    return { kind: 'block', reason: 'shard predicate returned BLOCK' }
  }
  return { kind: 'block', reason: 'shard predicate produced no recognized verdict token' }
}
