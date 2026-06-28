import { scriptApi } from '@/api/script-api'
import { worktreeApi } from '@/api/worktree-api'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeContextCacheStore } from '@/stores/useWorktreeContextCacheStore'
import type { WorktreeContextToken } from './worktree-context-constants'

export type { WorktreeContextToken } from './worktree-context-constants'
export {
  DEFAULT_CONTEXT_TEMPLATE,
  WORKTREE_CONTEXT_TOKENS,
  WORKTREE_CONTEXT_TOKEN_HELP
} from './worktree-context-constants'

const DEFAULT_SETUP_TIMEOUT_MS = 120_000
const SETUP_OUTPUT_TAIL_LINES = 60

export interface AwaitSetupResult {
  status: 'done' | 'error' | 'timeout'
  error?: string
}

/**
 * Wait for a worktree's setup script to finish.
 *
 * State-first: if `setupRunning` is already false we resolve immediately — this
 * covers the no-setup, already-done, and chain-member cases where the `'done'`
 * event has already fired (and `fireSetupScript` has unsubscribed). Otherwise we
 * subscribe to the setup channel *and* poll `setupRunning` every 250ms so a
 * subscription that lands a tick after `'done'` still resolves. Both are torn
 * down in `finally`, and the whole thing races a timeout.
 */
export async function awaitWorktreeSetup(
  worktreeId: string,
  options: { timeoutMs?: number } = {}
): Promise<AwaitSetupResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS

  const initial = useScriptStore.getState().getScriptState(worktreeId)
  if (!initial.setupRunning) {
    return initial.setupError ? { status: 'error', error: initial.setupError } : { status: 'done' }
  }

  return new Promise<AwaitSetupResult>((resolve) => {
    let settled = false
    let unsub: (() => void) | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      unsub?.()
      if (pollTimer !== null) clearInterval(pollTimer)
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
    }

    const finish = (result: AwaitSetupResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const resolveFromState = (): void => {
      const state = useScriptStore.getState().getScriptState(worktreeId)
      if (state.setupRunning) return
      finish(state.setupError ? { status: 'error', error: state.setupError } : { status: 'done' })
    }

    unsub = scriptApi.onOutput(`script:setup:${worktreeId}`, (event) => {
      if (event.type === 'error') {
        const state = useScriptStore.getState().getScriptState(worktreeId)
        finish({
          status: 'error',
          error:
            state.setupError ??
            (event.command ? `Command failed: ${event.command}` : 'Setup command failed')
        })
      } else if (event.type === 'done') {
        finish({ status: 'done' })
      }
    })

    pollTimer = setInterval(resolveFromState, 250)
    timeoutTimer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)

    // Re-check immediately in case state flipped between the top-level read and
    // the subscription landing.
    resolveFromState()
  })
}

export interface WorktreeContextScanTarget {
  id: string
  path: string
  branch_name?: string | null
  base_branch?: string | null
}

export type WorktreeContextValues = Partial<Record<WorktreeContextToken, string>>

/** Strip the in-band control markers `useScriptStore` prepends to setup lines. */
function cleanSetupLine(line: string): string {
  if (line.startsWith('\x00CMD:')) return `$ ${line.slice('\x00CMD:'.length)}`
  if (line.startsWith('\x00ERR:')) return line.slice('\x00ERR:'.length)
  if (line.startsWith('\x00NOTICE:')) return line.slice('\x00NOTICE:'.length)
  return line
}

function formatEnv(vars: Array<{ key: string; value: string }>): string {
  return vars
    .filter((entry) => entry.key.trim().length > 0)
    .map((entry) => `${entry.key}=${entry.value}`)
    .join('\n')
}

/**
 * Read the live context of a worktree: assigned port + dev URL (reusing the
 * existing `scriptApi.getPort` RPC — no new RPC), branch info from the row, saved
 * notes, the tail of the setup output, and the configured env. Tokens with no
 * value are returned absent and render as empty strings.
 */
export async function scanWorktreeContext(
  target: WorktreeContextScanTarget
): Promise<WorktreeContextValues> {
  const values: WorktreeContextValues = {}

  if (target.branch_name) values.BRANCH = target.branch_name
  if (target.base_branch) values.BASE_BRANCH = target.base_branch
  if (target.path) values.WORKTREE_PATH = target.path

  try {
    const { port } = await scriptApi.getPort(target.path)
    if (port != null) {
      values.PORT = String(port)
      values.DEV_URL = `http://localhost:${port}`
    }
  } catch {
    // Port lookup is best-effort — omit on failure.
  }

  try {
    const result = await worktreeApi.getContext(target.id)
    const notes = result.context?.trim()
    if (notes) values.WORKTREE_CONTEXT = notes
  } catch {
    // Connection targets and the like have no worktree row — omit gracefully.
  }

  const setupOutput = useScriptStore.getState().getScriptState(target.id).setupOutput
  if (setupOutput.length > 0) {
    const tail = setupOutput
      .slice(-SETUP_OUTPUT_TAIL_LINES)
      .map(cleanSetupLine)
      .join('\n')
      .trim()
    if (tail) values.SETUP_OUTPUT = tail
  }

  const env = formatEnv(useSettingsStore.getState().environmentVariables)
  if (env) values.ENV = env

  return values
}

/** True when the template references the (expensive, opt-in) AI summary token. */
export function templateWantsSummary(template: string): boolean {
  return template.includes('{{WORKTREE_SUMMARY}}')
}

/**
 * Get-or-generate the per-worktree AI summary via the single-flight cache.
 * Concurrent tickets in the same worktree share one CLI gather; the result is
 * cached + reused. Best-effort — returns absent on failure.
 */
async function resolveWorktreeSummary(
  target: WorktreeContextScanTarget
): Promise<string | undefined> {
  try {
    const summary = await useWorktreeContextCacheStore.getState().getOrGenerate({
      worktreeId: target.id,
      worktreePath: target.path,
      branch: target.branch_name ?? ''
    })
    return summary || undefined
  } catch {
    return undefined
  }
}

/** Substitute `{{TOKEN}}` placeholders; unknown / missing tokens become ''. */
export function renderContextTemplate(template: string, values: WorktreeContextValues): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, token: string) => {
    return values[token as WorktreeContextToken] ?? ''
  })
}

function joinPrompt(base: string, contextBlock: string): string {
  const trimmedBase = base.trim()
  if (!trimmedBase) return contextBlock
  return `${trimmedBase}\n\n${contextBlock}`
}

export interface PreparedLaunch {
  status: 'done' | 'blocked'
  /** Fully composed prompt: base prompt + the rendered context block. */
  prompt: string
  /** Present when blocked (setup error/timeout). */
  error?: string
}

/**
 * Drive the leak-proof gated launch: wait for setup, scan the worktree, and
 * compose the final prompt. On setup failure/timeout the prompt still carries a
 * context block (prefixed `Setup FAILED:`) so the user can "Launch anyway".
 */
export async function prepareWorktreeContextLaunch(params: {
  worktreeId: string | null
  scanTarget: WorktreeContextScanTarget | null
  basePrompt: string
  template: string
  timeoutMs?: number
}): Promise<PreparedLaunch> {
  const { worktreeId, scanTarget, basePrompt, template } = params

  const setup: AwaitSetupResult = worktreeId
    ? await awaitWorktreeSetup(
        worktreeId,
        params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}
      )
    : { status: 'done' }

  const values = scanTarget ? await scanWorktreeContext(scanTarget) : {}

  if (setup.status === 'done') {
    // The AI summary is expensive, so only gather it when the template asks for
    // it — and only after setup succeeded (no point summarizing a half-built
    // worktree). The cache makes this run once per worktree, then reuse.
    if (scanTarget && templateWantsSummary(template)) {
      const summary = await resolveWorktreeSummary(scanTarget)
      if (summary) values.WORKTREE_SUMMARY = summary
    }
    return {
      status: 'done',
      prompt: joinPrompt(basePrompt, renderContextTemplate(template, values))
    }
  }

  const errorMessage =
    setup.status === 'timeout'
      ? 'Setup timed out before completing'
      : (setup.error ?? 'Setup script failed')
  const failedSetupOutput = values.SETUP_OUTPUT
    ? `Setup FAILED: ${errorMessage}\n\n${values.SETUP_OUTPUT}`
    : `Setup FAILED: ${errorMessage}`
  const failValues: WorktreeContextValues = { ...values, SETUP_OUTPUT: failedSetupOutput }

  return {
    status: 'blocked',
    prompt: joinPrompt(basePrompt, renderContextTemplate(template, failValues)),
    error: errorMessage
  }
}
