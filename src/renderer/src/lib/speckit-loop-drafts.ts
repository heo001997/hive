/**
 * Programmatic Speckit loop-batch builder — the deterministic, Hive-owned
 * replacement for the agent emitting a `board-ticket-drafts` block and pasting
 * `generate_drafts.py --mode loop` output. When `/speckit-review` writes a `fix`
 * verdict to `.hive/review-gate.json`, the gate (`useKanbanStore.runSpeckitGate`)
 * builds the next round HERE and creates it directly — no agent text, no regex.
 *
 * The ticket content mirrors `scripts/generate_drafts.py` (the canonical flow
 * definition) so a Hive-spawned round is indistinguishable from a generator-made
 * one — EXCEPT the review gate text, which now points at the JSON contract instead
 * of the old "emit a drafts block / paste verbatim" protocol.
 */
import type { CreatableTicketDraft } from './create-tickets-from-drafts'

/**
 * The Speckit card number a chain belongs to, parsed from the trailing `— {N}` id
 * in a ticket title (e.g. "Speckit review (gate, round 1) — 2836-2" → "2836-2").
 * Returns null when the title carries no `— {id}` suffix.
 */
export function parseSpeckitCardId(title: string | null | undefined): string | null {
  const match = /—\s*([^—]+?)\s*$/.exec(title ?? '')
  return match ? match[1] : null
}

/** Generic "do the work" ticket body — mirrors `generate_drafts.build_workflow`. */
function buildWorkflow(step1Line: string, extraSteps: string[] = []): string {
  const lines = [
    'Workflow you MUST DO:',
    '',
    `1. ${step1Line}`,
    '2. READ THE CLAUDE.md file.',
    '3. Already on the right branch — no need to switch.',
    '4. Read the Trello card for context.'
  ]
  let n = 5
  for (const step of extraSteps) {
    lines.push(`${n}. ${step}`)
    n += 1
  }
  lines.push(`${n}. Do the work.`)
  return lines.join('\n')
}

/**
 * The review GATE description — identical on the base review and every loop review.
 * It tells the agent to run `/speckit-review` (which writes the machine-readable
 * `.hive/review-gate.json`) and then DO NOTHING ELSE: Hive reads that file and
 * routes the three outcomes deterministically. No `board-ticket-drafts`, no
 * `generate_drafts.py`, no "paste verbatim", no self-moving the ticket.
 */
export function buildSpeckitGateDescription(): string {
  return [
    'Workflow you MUST DO:',
    '',
    '1. READ `/speckit-review` to run the full code review against spec and plan.',
    '2. READ THE CLAUDE.md file.',
    '3. Already on the right branch — no need to switch.',
    '4. Read the Trello card for context.',
    '5. Run the review. It writes the gate verdict to `.hive/review-gate.json`',
    '   ({ "verdict": "pass" | "fix" | "needs-human", "reason": "...", "fixes": ["..."] }).',
    '6. GATE — do NOT create tickets, move this ticket, or paste any drafts block.',
    '   Hive reads `.hive/review-gate.json` and routes automatically:',
    '     • "pass"        → the feature flow is COMPLETE.',
    '     • "fix"         → Hive auto-creates the next fix round (fix → review-plan → review).',
    '     • "needs-human" → Hive leaves this ticket in Review and notifies Tu to decide.'
  ].join('\n')
}

/**
 * Build a fresh, self-contained 3-ticket fix batch for round `round`
 * (`fix-r{round}` → `review-plan-r{round}` → `review-r{round}`). NOT wired back to
 * the failing review — reality gated it, not a graph edge — so the loop can repeat
 * any number of rounds. `cardId` is the Speckit card number; `fixes` (from the
 * review verdict) is folded into the fix ticket so the fix agent has the findings.
 */
export function buildSpeckitLoopDrafts(
  cardId: string,
  projectId: string,
  round: number,
  fixes: string[] = []
): CreatableTicketDraft[] {
  const fixKey = `fix-r${round}`
  const reviewPlanKey = `review-plan-r${round}`
  const reviewKey = `review-r${round}`

  const fixExtra =
    fixes.length > 0
      ? ['Findings to fix (from the review):', ...fixes.map((f, i) => `   ${i + 1}. ${f}`)]
      : []

  return [
    {
      id: fixKey,
      draftKey: fixKey,
      title: `Speckit fix (round ${round}) — ${cardId}`,
      description: buildWorkflow(
        'READ `/speckit-fix` to fix the code flagged by the review.',
        fixExtra
      ),
      projectId,
      dependsOn: []
    },
    {
      id: reviewPlanKey,
      draftKey: reviewPlanKey,
      title: `Speckit review-plan (round ${round}) — ${cardId}`,
      description: buildWorkflow(
        'READ `/speckit-review-plan` to regenerate the review plan after the fix, before the re-review.'
      ),
      projectId,
      dependsOn: [fixKey]
    },
    {
      id: reviewKey,
      draftKey: reviewKey,
      title: `Speckit review (gate, round ${round}) — ${cardId}`,
      description: buildSpeckitGateDescription(),
      projectId,
      dependsOn: [reviewPlanKey]
    }
  ]
}
