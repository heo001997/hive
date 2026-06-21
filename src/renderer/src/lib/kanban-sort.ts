import type { KanbanTicket } from '../../../main/db/types'

export type SortField = 'created' | 'updated' | 'title'
export type SortDir = 'asc' | 'desc'

/**
 * Spacing between consecutive `sort_order` values after a one-shot column sort.
 * Consumers assign `sort_order = (index + 1) * SORT_STEP` across the GLOBAL
 * ordered list so multi-project merges reproduce the interleave (merge getters
 * re-sort by `sort_order`). The gap leaves room for later fractional drags.
 */
export const SORT_STEP = 1000

/**
 * Return a new array of `tickets` ordered by `field`/`dir`. Pure — does not
 * mutate the input.
 *
 * - `created`/`updated`: compare ISO 8601 strings (`created_at`/`updated_at`);
 *   lexicographic order equals chronological order for ISO strings.
 * - `title`: `localeCompare` with `sensitivity: 'base'` (case/accent-insensitive,
 *   A→Z).
 *
 * `asc` = oldest-first / A→Z; `desc` reverses. Ties break stably on `id` so the
 * result is deterministic.
 */
export function sortTicketsBy(
  tickets: KanbanTicket[],
  field: SortField,
  dir: SortDir
): KanbanTicket[] {
  const factor = dir === 'asc' ? 1 : -1

  const compare = (a: KanbanTicket, b: KanbanTicket): number => {
    let primary: number
    if (field === 'title') {
      primary = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    } else {
      const av = field === 'created' ? a.created_at : a.updated_at
      const bv = field === 'created' ? b.created_at : b.updated_at
      primary = av < bv ? -1 : av > bv ? 1 : 0
    }
    if (primary !== 0) return primary * factor
    // Stable tiebreak on id (also flips with direction to stay deterministic).
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * factor
  }

  return [...tickets].sort(compare)
}
