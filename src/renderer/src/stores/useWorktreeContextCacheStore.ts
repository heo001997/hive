import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { worktreeApi } from '@/api/worktree-api'

interface CachedSummary {
  summary: string
  /** Branch the summary was generated on — a mismatch triggers regeneration. */
  branch: string
  generatedAt: number
}

interface WorktreeContextCacheState {
  /** Persisted per-worktree summaries, keyed by worktreeId. */
  summaries: Record<string, CachedSummary>
  /**
   * Get the cached worktree summary, generating it once if missing/stale. Two
   * tickets launching in the same worktree at once share a single in-flight
   * generation (module-level lock below) — the CLI gather runs exactly once and
   * every subsequent ticket reads the cache. Returns '' on failure (graceful).
   */
  getOrGenerate: (params: {
    worktreeId: string
    worktreePath: string
    branch: string
  }) => Promise<string>
  /** Drop a cached summary so the next launch regenerates it. */
  clearSummary: (worktreeId: string) => void
}

// Cap on retained summaries. Each is a CLI-gathered repo digest (can be tens of
// KB) and the map is persisted to localStorage, so without a bound it grows once
// per worktree forever — leaking renderer RAM and eventually blowing the
// localStorage quota. A worktree's summary regenerates on demand, so evicting a
// stale one is cheap.
export const MAX_CACHED_SUMMARIES = 40

// Single-flight lock. Lives outside the store (not state, never persisted) so
// concurrent callers for the same worktree await one shared promise.
const inFlight = new Map<string, Promise<string>>()

/**
 * Return `summaries` trimmed to at most `max` entries, dropping the oldest by
 * `generatedAt` first. Pure (no store access) so it can be unit-tested. Returns
 * the same reference unchanged when already within the cap.
 */
export function evictOldestSummaries<T extends { generatedAt: number }>(
  summaries: Record<string, T>,
  max = MAX_CACHED_SUMMARIES
): Record<string, T> {
  const ids = Object.keys(summaries)
  if (ids.length <= max) return summaries
  const keep = ids
    .sort((a, b) => summaries[b].generatedAt - summaries[a].generatedAt)
    .slice(0, max)
  const next: Record<string, T> = {}
  for (const id of keep) next[id] = summaries[id]
  return next
}

export const useWorktreeContextCacheStore = create<WorktreeContextCacheState>()(
  persist(
    (set, get) => ({
      summaries: {},

      getOrGenerate: async ({ worktreeId, worktreePath, branch }) => {
        const cached = get().summaries[worktreeId]
        if (cached && cached.branch === branch) return cached.summary

        const existing = inFlight.get(worktreeId)
        if (existing) return existing

        const promise = (async (): Promise<string> => {
          try {
            const result = await worktreeApi.generateContextSummary(worktreePath)
            const summary = result.success && result.summary ? result.summary : ''
            if (summary) {
              set((state) => ({
                summaries: evictOldestSummaries({
                  ...state.summaries,
                  [worktreeId]: { summary, branch, generatedAt: Date.now() }
                })
              }))
            }
            return summary
          } catch {
            return ''
          } finally {
            inFlight.delete(worktreeId)
          }
        })()

        inFlight.set(worktreeId, promise)
        return promise
      },

      clearSummary: (worktreeId) =>
        set((state) => {
          if (!(worktreeId in state.summaries)) return state
          const next = { ...state.summaries }
          delete next[worktreeId]
          return { summaries: next }
        })
    }),
    {
      name: 'hive-worktree-context-cache',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ summaries: state.summaries })
    }
  )
)
