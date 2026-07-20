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
// The pure Condition-Gate helpers now live in `src/shared/` so the server/main
// process can share them (no server file may import this renderer module). They are
// imported here (used below by `isGateTicket`) AND re-exported so every existing
// `@/lib/ticket-lifecycle` import keeps resolving untouched.
import {
  buildConditionGateConfig,
  conditionGateConfigOf,
  decideConditionGate,
  isConditionGate,
  isReviewGateDraft,
  safeGateRegex,
  setConditionGate,
  DEFAULT_CONDITION_GATE_KEY_PATTERN,
  DEFAULT_CONDITION_GATE_WORD_PATTERN,
  DEFAULT_GATE_KEY_RE,
  DEFAULT_GATE_WORD_RE
} from '@shared/lib/condition-gate'
import type {
  ConditionGateActionConfig,
  ConditionGateDecision,
  ConditionGateMatchMode,
  GateMatchConfig,
  ReviewGateDraftLike
} from '@shared/lib/condition-gate'

export type { LifecycleSlot, LifecycleEntryContext } from '@shared/types/ticket-lifecycle'

export {
  buildConditionGateConfig,
  conditionGateConfigOf,
  decideConditionGate,
  isConditionGate,
  isReviewGateDraft,
  safeGateRegex,
  setConditionGate,
  DEFAULT_CONDITION_GATE_KEY_PATTERN,
  DEFAULT_CONDITION_GATE_WORD_PATTERN,
  DEFAULT_GATE_KEY_RE,
  DEFAULT_GATE_WORD_RE
}
export type {
  ConditionGateActionConfig,
  ConditionGateDecision,
  ConditionGateMatchMode,
  GateMatchConfig,
  ReviewGateDraftLike
}

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
 * True when `cfg` marks a review gate (a condition-gate `evaluate` action). The
 * umbrella check for "is this a gate ticket at all?".
 */
export function isGateTicket(cfg?: TicketLifecycleConfig | null): boolean {
  return isConditionGate(cfg)
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
 * zero flags). It writes the pre-built batch JSON to a TEMP file OUTSIDE the repo,
 * runs the `hive-ticket` CLI once, deletes the temp file, then STOPS — it CRUDs the
 * next round's tickets, it does NOT implement the fixes itself (the fix ticket's own
 * agent does that on launch).
 *
 * The batch file is deliberately kept out of the working tree (an OS temp file) so
 * this Hive-generated CLI input never shows up in the user's project `git status`.
 */
export function buildFixRoundPrompt(p: FixRoundPromptParams): string {
  const batch = buildFixRoundBatch(p)
  const json = JSON.stringify(batch, null, 2)
  return `A code review found issues that need fixing. Open the next fix round (round ${p.round}) by creating three linked tickets on the Hive board — do NOT fix anything yourself.

You are running inside the reviewed ticket's git worktree. The Hive CLI is pre-authed via injected \`HIVE_*\` env (project, worktree, port, token all set) — call it with no connection flags.

Do exactly this, in order:
1. Create the batch file OUTSIDE the repository (so it never shows up in the project's git status), run the Hive CLI on it, then delete it — run this exact shell block (the CLI resolves the \`dependsOn\` chain by \`draftKey\` and threads the shared worktree so all three share one branch = one PR):

\`\`\`bash
BATCH_FILE="$(mktemp "\${TMPDIR:-/tmp}/hive-round-${p.round}-XXXXXX")"
cat > "$BATCH_FILE" <<'HIVE_BATCH_EOF'
${json}
HIVE_BATCH_EOF
node "$HIVE_TICKET_CLI" batch "$BATCH_FILE"
rm -f "$BATCH_FILE"
\`\`\`

2. Confirm the CLI printed three \`Created:\` lines. If it errored, report the exact error and stop. Do NOT edit code, do NOT implement the fixes, do NOT write any file into the repository — creating the three tickets is your only job. Once the three tickets exist, you are done.`
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
