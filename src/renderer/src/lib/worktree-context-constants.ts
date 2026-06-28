// Leaf module: NO store imports. `useSettingsStore` imports the default template
// from here (not vice versa) so the settings store stays free of an import cycle.

/** Tokens substituted into the worktree-context template at launch time. */
export const WORKTREE_CONTEXT_TOKENS = [
  'PORT',
  'DEV_URL',
  'BRANCH',
  'BASE_BRANCH',
  'WORKTREE_PATH',
  'WORKTREE_CONTEXT',
  'SETUP_OUTPUT',
  'ENV',
  'WORKTREE_SUMMARY'
] as const

export type WorktreeContextToken = (typeof WORKTREE_CONTEXT_TOKENS)[number]

/** Short human description of each token, used by the UI legend. */
export const WORKTREE_CONTEXT_TOKEN_HELP: Record<WorktreeContextToken, string> = {
  PORT: 'Assigned dev-server port (blank if auto-assign is off)',
  DEV_URL: 'http://localhost:<port> (blank when no port)',
  BRANCH: 'The worktree branch',
  BASE_BRANCH: 'Branch the worktree was created from',
  WORKTREE_PATH: 'Absolute path of the worktree',
  WORKTREE_CONTEXT: 'Notes you saved on the worktree',
  SETUP_OUTPUT: 'Tail of the setup-script output',
  ENV: 'Environment variables (KEY=VALUE)',
  WORKTREE_SUMMARY:
    'AI-generated project orientation (stack, how to run, key dirs). Generated once per worktree by Claude Code CLI, then cached + reused. Costs tokens — only fires when this token is present.'
}

/** Default template the agent prompt is augmented with when context injection is on. */
export const DEFAULT_CONTEXT_TEMPLATE = `<worktree-context>
You are working inside an isolated git worktree. Its live environment:

- Branch: {{BRANCH}}
- Base branch: {{BASE_BRANCH}}
- Worktree path: {{WORKTREE_PATH}}
- Dev server port: {{PORT}}
- Dev server URL: {{DEV_URL}}

Notes:
{{WORKTREE_CONTEXT}}

Environment variables:
{{ENV}}

Setup script output:
{{SETUP_OUTPUT}}
</worktree-context>`
