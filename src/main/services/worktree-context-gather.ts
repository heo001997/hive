import { createLogger } from './logger'
import { resolveClaudeBinaryPath } from './claude-binary-resolver'
import { spawnCLI } from './title-generation-shared'

const log = createLogger({ component: 'WorktreeContextGather' })

/** Generous: the agent reads files in the worktree before answering. */
const GATHER_TIMEOUT_MS = 120_000
/** Cap the stored summary so a runaway response can't bloat the prompt. */
const MAX_SUMMARY_CHARS = 4_000

const GATHER_PROMPT = `You are orienting a fresh coding agent that is about to work in this repository.
Inspect the project (read package manifests, README, config, and the directory layout) and write a
concise orientation. Plain text only — no preamble, no markdown headings, under 300 words.

Cover, when discoverable:
- What the project is and its tech stack / language / framework.
- How to install, run the dev server, build, and run tests (exact commands).
- The key directories and entry points an agent should know.
- Project-specific conventions, gotchas, or constraints.

If something is not discoverable, omit it — do not guess.`

/**
 * Generate a one-time, read-only worktree orientation summary by spawning a
 * headless `claude -p` agent **inside the worktree** in plan mode (it can read
 * and explore but cannot edit or run destructive commands). Returns the trimmed
 * summary text. Throws on spawn failure so the caller can fall back gracefully.
 */
export async function gatherWorktreeContextSummary(worktreePath: string): Promise<string> {
  const binary = resolveClaudeBinaryPath() || 'claude'

  // Plan mode mirrors `buildClaudeCliPtySpawn` — read-only exploration with no
  // interactive permission prompts. Haiku keeps this cheap; it runs once per
  // worktree and is then cached + reused across every ticket that shares it.
  const args = [
    '-p',
    '--allow-dangerously-skip-permissions',
    '--permission-mode',
    'plan',
    '--model',
    'haiku',
    '--effort',
    'low',
    '--no-session-persistence'
  ]

  log.info('gatherWorktreeContextSummary: spawning', { worktreePath, binary })

  const stdout = await spawnCLI(binary, args, GATHER_PROMPT, GATHER_TIMEOUT_MS, worktreePath)
  const summary = stdout.trim().slice(0, MAX_SUMMARY_CHARS)

  log.info('gatherWorktreeContextSummary: done', {
    worktreePath,
    summaryLength: summary.length
  })

  return summary
}
