import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useKanbanStore, type TicketKey } from '@/stores/useKanbanStore'

/** Viewport-coordinate rectangle for the rubber-band overlay. */
export interface MarqueeRect {
  left: number
  top: number
  width: number
  height: number
}

// Movement (px) before a background mouse-drag counts as a marquee rather than
// a plain click. Below this, mouseup is treated as a click on empty space.
const DRAG_THRESHOLD_PX = 4

interface MarqueeOptions {
  /** When true the gesture is inert (e.g. dependency mode owns the board). */
  disabled?: boolean
}

// A background mousedown that should NOT start a marquee: cards handle their own
// drag/click, and interactive controls must keep working.
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  return !!target.closest(
    '[data-ticket-id], button, a, input, textarea, select, [role="menu"], [role="dialog"], [role="menuitem"]'
  )
}

function rectsIntersect(a: MarqueeRect, b: DOMRect): boolean {
  return (
    a.left < b.right &&
    a.left + a.width > b.left &&
    a.top < b.bottom &&
    a.top + a.height > b.top
  )
}

/**
 * Rubber-band (marquee) multi-select for the kanban board.
 *
 * Starting a drag on empty board background draws a selection rectangle; every
 * ticket card it intersects is added to `selectedTicketKeys` live. Holding
 * Shift/Cmd/Ctrl unions with the existing selection instead of replacing it.
 * A drag shorter than {@link DRAG_THRESHOLD_PX} is treated as a click on empty
 * space and clears the selection.
 */
export function useMarqueeSelection(
  boardRef: RefObject<HTMLElement | null>,
  { disabled = false }: MarqueeOptions = {}
): { marqueeRect: MarqueeRect | null; onMouseDown: (e: React.MouseEvent) => void } {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null)

  // Live gesture bookkeeping kept in a ref so window listeners read fresh values
  // without re-binding on every mousemove.
  const drag = useRef<{
    startX: number
    startY: number
    active: boolean
    baseKeys: Set<TicketKey>
    raf: number | null
  } | null>(null)

  const computeSelection = useCallback(
    (rect: MarqueeRect) => {
      const board = boardRef.current
      const state = drag.current
      if (!board || !state) return
      const next = new Set(state.baseKeys)
      const cards = board.querySelectorAll<HTMLElement>('[data-ticket-key]')
      cards.forEach((card) => {
        const key = card.getAttribute('data-ticket-key')
        if (!key) return
        if (rectsIntersect(rect, card.getBoundingClientRect())) next.add(key)
      })
      useKanbanStore.getState().setSelectedTicketKeys(next)
    },
    [boardRef]
  )

  const endDrag = useCallback(() => {
    const state = drag.current
    if (state?.raf != null) cancelAnimationFrame(state.raf)
    drag.current = null
    setMarqueeRect(null)
    document.body.style.removeProperty('user-select')
  }, [])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return
      if (e.button !== 0) return // left button only
      if (isInteractiveTarget(e.target)) return

      // Prevent the browser from starting a native text selection on the drag.
      e.preventDefault()
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        baseKeys: additive
          ? new Set(useKanbanStore.getState().selectedTicketKeys)
          : new Set<TicketKey>(),
        raf: null
      }
    },
    [disabled]
  )

  // Window-level move/up listeners track the gesture even when the pointer
  // leaves the board. Bound once for the hook's lifetime.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const state = drag.current
      if (!state) return
      const left = Math.min(state.startX, e.clientX)
      const top = Math.min(state.startY, e.clientY)
      const width = Math.abs(e.clientX - state.startX)
      const height = Math.abs(e.clientY - state.startY)

      if (!state.active) {
        if (Math.max(width, height) < DRAG_THRESHOLD_PX) return
        state.active = true
        document.body.style.userSelect = 'none'
      }

      const rect: MarqueeRect = { left, top, width, height }
      setMarqueeRect(rect)
      // Coalesce intersection work to one pass per frame.
      if (state.raf == null) {
        state.raf = requestAnimationFrame(() => {
          state.raf = null
          computeSelection(rect)
        })
      }
    }

    const onUp = () => {
      const state = drag.current
      if (!state) return
      // A non-drag (plain click) on empty space clears any selection, unless the
      // user held a modifier (then leave the selection untouched).
      if (!state.active && state.baseKeys.size === 0) {
        useKanbanStore.getState().clearSelectedTicketKeys()
      }
      endDrag()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [computeSelection, endDrag])

  // Tear down a live gesture if the hook unmounts mid-drag.
  useEffect(() => endDrag, [endDrag])

  return { marqueeRect, onMouseDown }
}
