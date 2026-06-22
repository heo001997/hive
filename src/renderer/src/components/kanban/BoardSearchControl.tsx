import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useBoardSearchStore } from '@/stores/useBoardSearchStore'

/**
 * Top-bar control for filtering the kanban board. Collapsed it's a search icon;
 * clicking it (or pressing ⌘F / Ctrl+F) expands an inline input. Filtering is
 * driven through {@link useBoardSearchStore}, so it lives in the header without
 * overlapping board content.
 */
export function BoardSearchControl() {
  const isOpen = useBoardSearchStore((s) => s.isOpen)
  const query = useBoardSearchStore((s) => s.query)
  const matchCount = useBoardSearchStore((s) => s.matchCount)
  const open = useBoardSearchStore((s) => s.open)
  const close = useBoardSearchStore((s) => s.close)
  const toggle = useBoardSearchStore((s) => s.toggle)
  const setQuery = useBoardSearchStore((s) => s.setQuery)
  const inputRef = useRef<HTMLInputElement>(null)

  const focusInput = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  // Focus the field whenever the bar opens.
  useEffect(() => {
    if (isOpen) focusInput()
  }, [isOpen])

  // ⌘F / Ctrl+F opens the bar (overriding the browser's native find); Escape
  // closes it. Capture phase so it wins over global shortcuts.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        open()
        focusInput()
        return
      }
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open, close, isOpen])

  const hasQuery = query.trim().length > 0

  // The icon stays put in the top bar; the search field floats below it as a
  // popup so it overlays the board instead of taking up header space.
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        title="Find tickets (⌘F)"
        data-testid="board-search-trigger"
        className={isOpen ? 'bg-accent text-accent-foreground' : undefined}
      >
        <Search className="h-4 w-4" />
      </Button>
      {isOpen && (
        <div
          className="absolute right-0 top-full z-50 mt-2 flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5 shadow-lg"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find tickets…"
            data-testid="board-search-input"
            className="h-7 w-52 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          />
          {hasQuery && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {matchCount === 0 ? 'No results' : `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`}
            </span>
          )}
          <button
            onClick={close}
            aria-label="Close search"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
