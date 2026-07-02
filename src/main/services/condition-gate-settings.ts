/**
 * Read the Condition-Gate settings server-side (Part A2).
 *
 * The full renderer settings blob is persisted to the DB `settings` table under
 * `APP_SETTINGS_DB_KEY` (every `kanbanConditionGate*` key is in the persist
 * partialize of `useSettingsStore`). The create-RPC auto-arm (Part A3) runs in the
 * main/server process — it can't read the renderer store — so it reads the same blob
 * back through the existing `getAllSettingsMap()` helper. No migration, no new
 * plumbing: JSON.parse the blob, pull the gate keys, fall back to the shared defaults.
 */
import { DEFAULT_CONDITION_GATE_PROMPT } from '@shared/types/completion'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import {
  DEFAULT_CONDITION_GATE_KEY_PATTERN,
  DEFAULT_CONDITION_GATE_WORD_PATTERN,
  type ConditionGateMatchMode
} from '@shared/lib/condition-gate'

import { createLogger } from './logger'
import { getAllSettingsMap } from './settings-openers'

const log = createLogger({ component: 'condition-gate-settings' })

/** The resolved gate settings the server needs to auto-arm a review ticket. */
export interface ConditionGateSettings {
  /** Master switch — when false the server never seeds a gate. */
  enabled: boolean
  /** Fix-loop round cap before the gate blocks for the human. */
  maxRounds: number
  /** Stage-2 LLM provider (e.g. `claude-code`). */
  provider: string
  /** Optional model override (empty = provider default). */
  model: string
  /** Stage-2 system-prompt. */
  prompt: string
  /** When true a clean `pass` may auto-advance a terminal review to Done. */
  autoDone: boolean
  /** How `isReviewGateDraft` matches: by key, by description word, or either. */
  matchMode: ConditionGateMatchMode
  /** Regex source matched (case-insensitively) against the draft key. */
  keyPattern: string
  /** Regex source matched (case-insensitively) against the description. */
  wordPattern: string
}

/** The defaults the seeding path uses when a key is absent from the persisted blob. */
const DEFAULTS: ConditionGateSettings = {
  enabled: false,
  maxRounds: 3,
  provider: 'claude-code',
  model: '',
  prompt: DEFAULT_CONDITION_GATE_PROMPT,
  autoDone: false,
  matchMode: 'both',
  keyPattern: DEFAULT_CONDITION_GATE_KEY_PATTERN,
  wordPattern: DEFAULT_CONDITION_GATE_WORD_PATTERN
}

/**
 * Load the Condition-Gate settings from the persisted `APP_SETTINGS_DB_KEY` blob.
 * Any parse failure / missing key degrades gracefully to {@link DEFAULTS} — a broken
 * settings row must never crash ticket creation (it just leaves the gate disabled).
 */
export function readConditionGateSettings(): ConditionGateSettings {
  let blob: Record<string, unknown> = {}
  try {
    const raw = getAllSettingsMap()[APP_SETTINGS_DB_KEY] ?? '{}'
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') blob = parsed as Record<string, unknown>
  } catch (err) {
    log.warn('failed to parse app settings blob — using condition-gate defaults', {
      error: err instanceof Error ? err.message : String(err)
    })
    return { ...DEFAULTS }
  }

  const str = (key: string, fallback: string): string =>
    typeof blob[key] === 'string' && (blob[key] as string).length > 0
      ? (blob[key] as string)
      : fallback
  const num = (key: string, fallback: number): number =>
    typeof blob[key] === 'number' && Number.isFinite(blob[key] as number)
      ? (blob[key] as number)
      : fallback
  const bool = (key: string, fallback: boolean): boolean =>
    typeof blob[key] === 'boolean' ? (blob[key] as boolean) : fallback

  const matchModeRaw = blob.kanbanConditionGateMatchMode
  const matchMode: ConditionGateMatchMode =
    matchModeRaw === 'key' || matchModeRaw === 'word' || matchModeRaw === 'both'
      ? matchModeRaw
      : DEFAULTS.matchMode

  return {
    enabled: bool('kanbanConditionGateEnabled', DEFAULTS.enabled),
    maxRounds: num('kanbanConditionGateMaxRounds', DEFAULTS.maxRounds),
    provider: str('kanbanConditionGateProvider', DEFAULTS.provider),
    // model is intentionally allowed to be '' (provider default) — read raw, not via `str`.
    model: typeof blob.kanbanConditionGateModel === 'string' ? blob.kanbanConditionGateModel : DEFAULTS.model,
    prompt: str('kanbanConditionGatePrompt', DEFAULTS.prompt),
    autoDone: bool('kanbanConditionGateAutoDone', DEFAULTS.autoDone),
    matchMode,
    keyPattern: str('kanbanConditionGateKeyPattern', DEFAULTS.keyPattern),
    wordPattern: str('kanbanConditionGateWordPattern', DEFAULTS.wordPattern)
  }
}
