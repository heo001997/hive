/**
 * Pure helpers for the per-ticket lifecycle-callback engine. No side effects — the
 * store (`useKanbanStore`) wires these into the existing Strict-Verify / rescue
 * seams via a single dispatcher. Fully unit-tested in
 * `__tests__/ticket-lifecycle.test.ts`.
 */
import type {
  LifecycleAction,
  LifecycleBranch,
  LifecycleEntryContext,
  LifecycleSlot,
  LifecycleState,
  LifecycleVerdict,
  TicketLifecycleConfig
} from '@shared/types/ticket-lifecycle'

export type { LifecycleSlot, LifecycleEntryContext } from '@shared/types/ticket-lifecycle'

/**
 * Default fix-prompt fed back to the agent when the Reviewer bounces a ticket.
 * `{{reason}}` is substituted with the Reviewer's one-line reason. Lives here so
 * the settings store seeds/resets to exactly this text.
 */
export const DEFAULT_FIX_PROMPT_TEMPLATE =
  'Review found the work incomplete:\n\n{{reason}}\n\nFix it, then stop.'

/** The canonical review↔fix loop config (the first concrete lifecycle instance). */
export function buildDefaultLoopConfig({
  maxIterations,
  fixPromptTemplate
}: {
  maxIterations: number
  fixPromptTemplate: string
}): TicketLifecycleConfig {
  const retryMax = Number.isFinite(maxIterations) ? Math.max(1, Math.floor(maxIterations)) : 3
  const template = fixPromptTemplate?.length ? fixPromptTemplate : DEFAULT_FIX_PROMPT_TEMPLATE
  return {
    enabled: true,
    states: {
      // DURING(review): the Strict-Verify Reviewer judges the work.
      // branches: a fail bounces back to In Progress; PASS has NO branch
      // (auto-approve / the human owns pass — the loop only owns fail).
      review: {
        during: [{ id: 'review-during', type: 'review', config: {} }],
        branches: [{ when: 'fail', goto: 'in_progress' }],
        retryMax
      },
      // RETRY(in_progress): re-arm the agent with the fix prompt on a loop bounce.
      // RETRY (not BEFORE) so a plain/first entry into In Progress never re-prompts.
      in_progress: {
        retry: [
          { id: 'in-progress-retry-prompt', type: 'prompt', config: { template }, runOn: ['retry'] }
        ]
      }
    }
  }
}

/** True when a config exists and is enabled. */
export function isLifecycleEnabled(cfg?: TicketLifecycleConfig | null): boolean {
  return !!cfg && cfg.enabled === true
}

/**
 * Config carried by an `evaluate` (condition-gate) action. All fields optional —
 * the store falls back to the global settings for anything unset. Stored inside a
 * `review.during` action's `config` (a `Record<string, unknown>`); read it back
 * with {@link conditionGateConfigOf}.
 */
export interface ConditionGateActionConfig {
  /** Stage-2 LLM provider (falls back to the global condition-gate / Strict-Verify provider). */
  provider?: string
  /** Optional model override (falls back to the global condition-gate model). */
  model?: string
  /** Optional Stage-2 system-prompt override (falls back to the global default). */
  prompt?: string
  /** Max fix-loop rounds before the gate blocks for the human (falls back to the global cap = 3). */
  maxRounds?: number
  /** When true, a clean `pass` may auto-advance to Done; default false (leave in Review for the human). */
  autoDone?: boolean
}

/**
 * The condition-GATE lifecycle config. A `DURING(review)` action of
 * `type: 'evaluate'` MARKS the review ticket as a two-stage gate; the engine
 * (`useKanbanStore.runConditionGate`) keys off it and reads its `config`. It has NO
 * `review.branches` fail→in_progress edge — the gate routes its own outcomes
 * (pass / fix / needs-human) after the Stage-1 Strict-Verify pass.
 */
export function buildConditionGateConfig(config: ConditionGateActionConfig = {}): TicketLifecycleConfig {
  // Drop undefined keys so the stored config stays minimal (and equality-friendly).
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined && v !== '') cleaned[k] = v
  }
  return {
    enabled: true,
    states: {
      review: {
        during: [{ id: 'condition-gate-evaluate', type: 'evaluate', config: cleaned }]
      }
    }
  }
}

/** True when `cfg` marks a condition gate (a `DURING(review)` `evaluate` action). */
export function isConditionGate(cfg?: TicketLifecycleConfig | null): boolean {
  return (
    isLifecycleEnabled(cfg) &&
    (cfg?.states?.review?.during ?? []).some((a) => a.type === 'evaluate')
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
    provider: typeof c.provider === 'string' ? c.provider : undefined,
    model: typeof c.model === 'string' ? c.model : undefined,
    prompt: typeof c.prompt === 'string' ? c.prompt : undefined,
    maxRounds:
      typeof c.maxRounds === 'number' && Number.isFinite(c.maxRounds) ? c.maxRounds : undefined,
    autoDone: c.autoDone === true
  }
}

/**
 * True when `cfg` marks a review gate (a condition-gate `evaluate` action). The
 * umbrella check for "is this a gate ticket at all?".
 */
export function isGateTicket(cfg?: TicketLifecycleConfig | null): boolean {
  return isConditionGate(cfg)
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

const DEFAULT_GATE_KEY_RE = /^review(-r\d+)?$/i
const DEFAULT_GATE_WORD_RE = /\/speckit-review(?![\w-])/i

/** User-tunable matcher config (from the Condition Gate settings). All optional → defaults. */
export interface GateMatchConfig {
  mode?: ConditionGateMatchMode
  /** Regex SOURCE tested (case-insensitively) against the draftKey. */
  keyPattern?: string
  /** Regex SOURCE tested (case-insensitively) against the description. */
  wordPattern?: string
}

/** Compile `source` as a case-insensitive regex; fall back to `fallback` on an empty/invalid pattern. */
function safeGateRegex(source: string | undefined, fallback: RegExp): RegExp {
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

/**
 * Parse the loop round of a review ticket from its title. Loop tickets carry
 * `(round {R})` (e.g. "Review (gate, round 3) — 2611"); the base review has none
 * → round 0. The round number itself stays agent-computed in the draft titles.
 */
export function parseGateRound(title: string | null | undefined): number {
  const match = /\(\s*(?:gate,\s*)?round\s+(\d+)\s*\)/i.exec(title ?? '')
  if (!match) return 0
  const n = Number.parseInt(match[1], 10)
  return Number.isFinite(n) && n > 0 ? n : 0
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

/** Inputs for the agent-driven fix-round prompt (P3). */
export interface FixRoundPromptParams {
  /** The NEXT round number R (1 for the first fix round off a base review). */
  round: number
  /** The shared worktree id every round ticket must reuse (one worktree = branch = one PR). */
  worktreeId: string
  /** The reviewed ticket's title (used to derive a human slug for the round tickets). */
  reviewTitle: string
  /** Stage-2 verdict — its `reason` + `fixes[]` are folded into the fix ticket. */
  verdict: { reason?: string; fixes?: string[] }
}

/**
 * Strip any trailing `(… round N) — 1234` gate suffix + id tail from a review
 * title so the derived round tickets get a clean, stable base label.
 */
function baseLabelFromReviewTitle(title: string): string {
  return (title || 'work')
    .replace(/\(\s*(?:gate,\s*)?round\s+\d+\s*\)/i, '')
    .replace(/\s*[—–-]\s*\d+\s*$/, '')
    .replace(/\breview(?:-plan)?\b/gi, '')
    .replace(/\s+/g, ' ')
    // Stripping the leading "Review" word can strand its "— " separator; trim any
    // leftover separator dashes/whitespace off both ends.
    .replace(/^[\s—–-]+|[\s—–-]+$/g, '')
    .trim() || 'work'
}

/**
 * Build the batch of three round tickets (`fix → review-plan → review`) as the
 * `hive-ticket` CLI's batch-file shape. Pure + deterministic so the caller embeds
 * exact JSON in the agent's prompt (rather than trusting the agent to compose it):
 *   - every item threads `worktreeId` so the whole round shares ONE worktree/branch/PR,
 *   - the chain is `review-plan` depends-on `fix`, `review` depends-on `review-plan`,
 *   - the new `review` is seeded as a condition gate (`gate: true`) so the loop re-enters,
 *   - the Stage-2 `fixes[]` + `reason` are folded into the fix ticket's description.
 */
export function buildFixRoundBatch(
  p: FixRoundPromptParams
): Array<Record<string, unknown>> {
  const r = p.round
  const label = baseLabelFromReviewTitle(p.reviewTitle)
  const fixList = (p.verdict.fixes ?? []).map((f) => `- ${f}`).join('\n').trim()
  const reason = p.verdict.reason?.trim() || ''
  const fixBody = [
    `Address the issues the round-${r - 1} review found, then leave the work ready for re-review.`,
    reason ? `\nReview summary: ${reason}` : '',
    fixList ? `\nConcrete fixes to make:\n${fixList}` : ''
  ]
    .join('')
    .trim()
  const planBody = `Plan the review of the round-${r} fixes.`
  const reviewBody = `Review the round-${r} fixes and report your findings (the condition gate reads your return).`

  // The launch config every round ticket carries so the existing auto-launch
  // machinery starts it — reusing THE SAME worktree as-is (no `reuseBranchBase`,
  // so all three commit to one branch = one PR) with the CLI SDK in build mode.
  const launchConfig = (prompt: string): Record<string, unknown> => ({
    worktree: { type: 'existing', worktreeId: p.worktreeId },
    prompt,
    mode: 'build',
    model: null,
    sdk: 'claude-code-cli',
    codexFastMode: false,
    goalMode: false,
    goalSuccessCriteria: null,
    autoApprovePlan: false,
    injectContext: false,
    runSetup: false
  })

  // `auto_approve_review: true` so fix/review-plan auto-advance out of Review and
  // unblock the next chain member unattended; the gate ticket routes its own outcome.
  const base = {
    column: 'todo',
    mode: 'build',
    autoApproveReview: true,
    worktreeId: p.worktreeId
  }

  return [
    {
      ...base,
      draftKey: `fix-r${r}`,
      title: `Fix (round ${r}) — ${label}`,
      description: fixBody,
      launchConfig: launchConfig(fixBody)
    },
    {
      ...base,
      draftKey: `review-plan-r${r}`,
      title: `Review plan (round ${r}) — ${label}`,
      description: planBody,
      dependsOn: [`fix-r${r}`],
      launchConfig: launchConfig(planBody)
    },
    {
      ...base,
      draftKey: `review-r${r}`,
      title: `Review (gate, round ${r}) — ${label}`,
      description: reviewBody,
      dependsOn: [`review-plan-r${r}`],
      gate: true,
      launchConfig: launchConfig(reviewBody)
    }
  ]
}

/**
 * Compose the prompt for the agent-driven fix round (P3). The agent runs in the
 * reviewed ticket's OWN worktree with `HIVE_*` env pre-injected (so the CLI needs
 * zero flags). It writes the pre-built batch JSON to a file and runs the
 * `hive-ticket` CLI once, then STOPS — it CRUDs the next round's tickets, it does
 * NOT implement the fixes itself (the fix ticket's own agent does that on launch).
 */
export function buildFixRoundPrompt(p: FixRoundPromptParams): string {
  const batch = buildFixRoundBatch(p)
  const json = JSON.stringify(batch, null, 2)
  return `A code review found issues that need fixing. Open the next fix round (round ${p.round}) by creating three linked tickets on the Hive board — do NOT fix anything yourself.

You are running inside the reviewed ticket's git worktree. The Hive CLI is pre-authed via injected \`HIVE_*\` env (project, worktree, port, token all set) — call it with no connection flags.

Do exactly this, in order:
1. Write the following JSON to a file \`round-${p.round}.json\` in the current directory:

\`\`\`json
${json}
\`\`\`

2. Run the Hive CLI to create the batch (it resolves the \`dependsOn\` chain by \`draftKey\` and threads the shared worktree so all three share one branch = one PR):

\`\`\`bash
node "$HIVE_TICKET_CLI" batch round-${p.round}.json
\`\`\`

3. Confirm the CLI printed three \`Created:\` lines. If it errored, report the exact error and stop. Do NOT edit code, do NOT implement the fixes — creating the three tickets is your only job. Once the three tickets exist, you are done.`
}

/**
 * The actions configured for `state`/`slot`, filtered by entry context. An action
 * with `runOn` set runs only when `context` is in its list; an action with no
 * `runOn` (or no `context` supplied) always runs. Returns an empty array when none.
 */
export function actionsForSlot(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState,
  slot: LifecycleSlot,
  context?: LifecycleEntryContext
): LifecycleAction[] {
  const actions = cfg?.states?.[state]?.[slot] ?? []
  if (!context) return actions
  return actions.filter((a) => !a.runOn || a.runOn.length === 0 || a.runOn.includes(context))
}

/** The branches configured for `state` (empty array when none). */
export function branchesForState(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState
): LifecycleBranch[] {
  return cfg?.states?.[state]?.branches ?? []
}

/** The loop-breaker cap for `state`, or undefined (no cap). */
export function retryMaxForState(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState
): number | undefined {
  return cfg?.states?.[state]?.retryMax
}

/**
 * Map the existing completion verdict (`{ complete, needsInput, confidence }`) to a
 * lifecycle verdict. `needsInput` wins (the agent is waiting on the user); otherwise
 * a confident `complete` is a pass, anything else is a fail.
 */
export function verdictToLifecycle(
  verdict: { complete: boolean; needsInput: boolean; confidence: number },
  threshold: number
): LifecycleVerdict {
  if (verdict.needsInput) return 'needsInput'
  if (verdict.complete && verdict.confidence >= threshold) return 'pass'
  return 'fail'
}

/**
 * Combine a slot's per-action verdicts into one: the first non-`pass` verdict wins
 * (a single failing action fails the slot), else `pass`. An empty list is `pass`.
 */
export function combineVerdicts(verdicts: LifecycleVerdict[]): LifecycleVerdict {
  return verdicts.find((v) => v !== 'pass') ?? 'pass'
}

/** Outcome of `decideBranch` — what the loop does given a verdict + iteration count. */
export type BranchDecision =
  | { kind: 'advance' }
  | { kind: 'goto'; state: LifecycleState }
  | { kind: 'stuck' }

/**
 * Decide the next move for `state` given `verdict` and the count of fail
 * iterations SO FAR (1-based — includes the current fail). A `pass` (or a verdict
 * with no matching branch, or `goto: 'end'`) → `advance` (the loop has nothing to
 * say; the caller falls back to its default behavior). A matching branch:
 *   - `iteration >= retryMax` → `stuck` (the cap is reached — break the loop)
 *   - otherwise               → `goto` the branch's destination state
 */
export function decideBranch(
  cfg: TicketLifecycleConfig | null | undefined,
  state: LifecycleState,
  verdict: LifecycleVerdict,
  iteration: number
): BranchDecision {
  if (verdict === 'pass') return { kind: 'advance' }
  const branch = branchesForState(cfg, state).find((b) => b.when === verdict)
  if (!branch || branch.goto === 'end') return { kind: 'advance' }

  const retryMax = retryMaxForState(cfg, state)
  if (typeof retryMax === 'number' && iteration >= retryMax) {
    return { kind: 'stuck' }
  }
  return { kind: 'goto', state: branch.goto }
}

/**
 * Substitute `{{reason}}`, `{{title}}`, and `{{iteration}}` in `template`. When the
 * template has no `{{reason}}` placeholder, the reason is appended so the agent
 * still learns WHY the work was bounced.
 */
export function renderTemplate(
  template: string,
  vars: { reason?: string; title?: string; iteration?: number }
): string {
  const reason = (vars.reason ?? '').trim()
  let out = template
    .split('{{title}}')
    .join(vars.title ?? '')
    .split('{{iteration}}')
    .join(vars.iteration != null ? String(vars.iteration) : '')
  if (out.includes('{{reason}}')) {
    return out.split('{{reason}}').join(reason)
  }
  if (!reason) return out
  out = `${out.trimEnd()}\n\n${reason}`
  return out
}
