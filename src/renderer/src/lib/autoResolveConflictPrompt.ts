// Prompt that the "Auto Resolve Conflict & Merge" button injects into the
// ticket's Claude CLI terminal. The default below is editable from
// Settings → General → "Auto-resolve conflict prompt"; the placeholders
// {prNumber} / {baseBranch} / {featureBranch} are substituted at fire time
// with the real PR/branch context so the editable text never has to hardcode them.

export const AUTO_RESOLVE_CONFLICT_PLACEHOLDERS = [
  '{prNumber}',
  '{baseBranch}',
  '{featureBranch}'
] as const

export const DEFAULT_AUTO_RESOLVE_CONFLICT_PROMPT = `PR #{prNumber} can't be merged into {baseBranch} — the branch {featureBranch} has conflicts with {baseBranch}. Resolve the conflict end-to-end yourself, right here in this worktree, then merge the PR.

1. Pull the target branch in:
   git fetch origin {baseBranch}
   git merge origin/{baseBranch}
2. Compare carefully. Before touching anything, read the conflicting code on BOTH sides — what this branch ({featureBranch}) changed vs. what {baseBranch} introduced. Figure out the intent of each side.
3. Understand this PR's purpose. Read the full diff (git diff origin/{baseBranch}...HEAD) and the PR itself (gh pr view {prNumber}). Resolve every conflict so the PR's original goal is still achieved AND the new code coming from {baseBranch} keeps working.
4. Adapt, don't just pick a side. If {baseBranch} added something that this PR's pattern should also cover, extend the PR to cover it. Example: if this PR adds a button to every screen and {baseBranch} added a new screen, add the button to that new screen too. Write whatever extra code is needed to integrate cleanly.
5. Finish it: once everything builds and conflicts are gone, commit, push, then merge the PR (gh pr merge {prNumber} --merge).
6. If you are unsure about a conflict and cannot decide correctly on your own, STOP and ask Tu instead of guessing.`

export interface AutoResolveConflictContext {
  prNumber: number
  /** PR base branch, e.g. "main". */
  baseBranch: string
  /** Current feature branch, e.g. "my-feature". */
  featureBranch: string
}

/**
 * Fill the editable template with the live PR/branch context. Falls back to the
 * default template when the stored value is blank, and substitutes every
 * placeholder occurrence so the prompt is concrete by the time it hits the terminal.
 */
export function buildAutoResolveConflictPrompt(
  template: string | undefined | null,
  ctx: AutoResolveConflictContext
): string {
  const base = (template ?? '').trim() || DEFAULT_AUTO_RESOLVE_CONFLICT_PROMPT
  return base
    .replaceAll('{prNumber}', String(ctx.prNumber))
    .replaceAll('{baseBranch}', ctx.baseBranch)
    .replaceAll('{featureBranch}', ctx.featureBranch)
}
