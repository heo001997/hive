import { create } from 'zustand'

/**
 * Bridges the kanban board's ticket filter with the search control in the app
 * top bar. The control (in Header) writes `query`/`isOpen`; the board reads them
 * to filter tickets and publishes `matchCount` back for the control to display.
 * `mounted` lets the Header show the control only while a board is on screen.
 */
interface BoardSearchState {
  /** True while a KanbanBoard is rendered (any mode: project/connection/pinned). */
  mounted: boolean
  isOpen: boolean
  query: string
  /** Number of tickets matching `query`, published by the board. */
  matchCount: number
  setMounted: (mounted: boolean) => void
  open: () => void
  close: () => void
  toggle: () => void
  setQuery: (query: string) => void
  setMatchCount: (count: number) => void
}

export const useBoardSearchStore = create<BoardSearchState>((set) => ({
  mounted: false,
  isOpen: false,
  query: '',
  matchCount: 0,
  // Leaving the board tears down the control, so also clear the active filter.
  setMounted: (mounted) =>
    set(mounted ? { mounted } : { mounted, isOpen: false, query: '', matchCount: 0 }),
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false, query: '', matchCount: 0 }),
  toggle: () =>
    set((state) =>
      state.isOpen ? { isOpen: false, query: '', matchCount: 0 } : { isOpen: true }
    ),
  setQuery: (query) => set({ query }),
  setMatchCount: (matchCount) => set({ matchCount })
}))
