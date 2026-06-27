import { terminalApi } from '@/api/terminal-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

/**
 * Inputs for the PR-creation prompt handed to the Claude Code CLI.
 */
export interface CreatePrPromptInput {
  /** Current (head) branch the PR is opened from. */
  headBranch: string
  /** Base branch name, e.g. "main". */
  baseBranch: string
  /** Remote that owns the base branch, e.g. "origin" or "upstream". */
  baseRemote: string
  /** Remote-qualified base ref, e.g. "origin/main" — used for the diff range. */
  baseRef: string
  /** User-provided title (empty → ask the CLI to generate one). */
  title: string
  /** User-provided body (empty → ask the CLI to generate one). */
  body: string
}

/**
 * Build the natural-language prompt that drives the Claude Code CLI to create the
 * pull request end-to-end: push the branch if needed, then open the PR with `gh`.
 *
 * The CLI runs in the worktree directory, so it has full access to git/gh and can
 * generate the title/body from the diff when the user left those fields blank.
 */
export function buildCreatePrPrompt(input: CreatePrPromptInput): string {
  const { headBranch, baseBranch, baseRemote, baseRef, title, body } = input
  const lines: string[] = [
    `Create a GitHub pull request for the current branch (\`${headBranch}\`) in this repository.`,
    '',
    'Do the following:',
    '1. If this branch has commits that are not yet pushed, push it to its remote first (e.g. `git push -u origin HEAD`).',
    `2. Open the pull request with the GitHub CLI, targeting the base branch \`${baseBranch}\` on remote \`${baseRemote}\`.`,
    ''
  ]

  if (title) {
    lines.push(`Title: ${title}`)
  } else {
    lines.push('Title: write a concise, specific title summarizing the change.')
  }

  if (body) {
    lines.push('Body:', body)
  } else {
    lines.push(
      `Body: write a markdown description with a "## Summary" section (short bullet points) and a "## Testing" section (concrete checks, or "Not run"), based on the commits and the diff against \`${baseRef}\`.`
    )
  }

  lines.push(
    '',
    `Run \`gh pr create --base ${baseBranch}\` with that title and body (add \`--head ${headBranch}\` if needed). After it succeeds, print the resulting pull request URL.`
  )

  return lines.join('\n')
}

/**
 * Open a brand-new Claude Code CLI terminal for the worktree and hand it the
 * PR-creation prompt so it pushes the branch and runs `gh pr create` itself.
 *
 * Mirrors the new-session launch path used by the kanban handoff and
 * {@link ClaudeCliSessionView}: the prompt lives in the session's pending-message
 * queue, and whichever `createClaudeCli` call dequeues it first (this one, or the
 * session view's own mount) delivers it — so it is never entered twice.
 *
 * When `ticketId` is given the terminal opens INLINE in that ticket's detail view
 * (view-only focus, like the Ticket Detail "+ terminal" button) instead of
 * switching the global view — so clicking Create PR from a ticket doesn't yank the
 * user out to the worktree/kanban screen. Without a ticket (worktree Header) it
 * focuses the new session as the active worktree session, where the user already is.
 */
export async function dispatchCreatePrViaClaudeCli(opts: {
  worktreeId: string
  worktreePath: string
  prompt: string
  ticketId?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const { worktreeId, worktreePath, prompt, ticketId } = opts

  // Resolve the project that owns this worktree — createSession needs it.
  let projectId: string | null = null
  for (const [pid, worktrees] of useWorktreeStore.getState().worktreesByProject) {
    if (worktrees.some((w) => w.id === worktreeId)) {
      projectId = pid
      break
    }
  }
  if (!projectId) {
    return { success: false, error: 'Could not resolve the project for this worktree' }
  }

  const sessionStore = useSessionStore.getState()
  const result = await sessionStore.createSession(worktreeId, projectId, 'claude-code-cli', 'build', {
    // From a ticket we focus the session view-only (setTicketActiveView below) so
    // the global view stays put; autoFocus would redirect to the worktree screen.
    autoFocus: !ticketId,
    skipKanbanAutoAttach: true,
    pendingMessage: prompt
  })
  if (!result.success || !result.session) {
    return { success: false, error: result.error ?? 'Failed to create a Claude Code CLI terminal' }
  }

  const newSessionId = result.session.id
  // Surface the new terminal so the user can watch the PR being created. From a
  // ticket, show it inline in the ticket's tab strip (view-only) and stay on the
  // ticket detail. From the Header, focus it as the active worktree session.
  if (ticketId) {
    sessionStore.setTicketActiveView(ticketId, newSessionId)
  } else {
    sessionStore.setActiveWorktree(worktreeId)
    sessionStore.setActiveSession(newSessionId)
  }

  // Claim the queued prompt before spawning so the session view's mount path
  // doesn't also deliver it (double-entry). Whoever wins the PTY spawn carries it.
  const outboundPrompt = sessionStore.dequeuePendingMessage(newSessionId)
  try {
    const cliResult = unwrapEnvelope(
      await terminalApi.createClaudeCli(newSessionId, { pendingPrompt: outboundPrompt })
    )
    if (!cliResult.success) {
      if (outboundPrompt) sessionStore.requeuePendingMessage(newSessionId, outboundPrompt)
      return { success: false, error: cliResult.error ?? 'Failed to start the Claude Code CLI' }
    }
  } catch (err) {
    if (outboundPrompt) sessionStore.requeuePendingMessage(newSessionId, outboundPrompt)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  // The CLI opens the PR in its own terminal, so the app won't learn the PR
  // number from this call. Poll `gh` for the new PR and attach it once it lands
  // so the "Create PR" button flips to the PR badge without a manual refresh.
  useGitStore.getState().pollForPRAttachment(worktreeId, worktreePath)

  return { success: true }
}
