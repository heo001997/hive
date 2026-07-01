import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { useTerminalOnScreen } from './use-terminal-on-screen'

// A controllable IntersectionObserver stand-in: tests capture the callback and
// drive intersection changes, and assert observe/disconnect wiring.
type IOCallback = (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void
const io = vi.hoisted(() => ({
  callback: null as IOCallback | null,
  observed: [] as unknown[],
  disconnected: 0
}))

class MockIntersectionObserver {
  constructor(cb: IOCallback) {
    io.callback = cb
  }
  observe(el: unknown): void {
    io.observed.push(el)
  }
  disconnect(): void {
    io.disconnected++
  }
  unobserve(): void {}
  takeRecords(): [] {
    return []
  }
}

function fire(isIntersecting: boolean): void {
  act(() => {
    io.callback?.([{ isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 }])
  })
}

describe('useTerminalOnScreen', () => {
  beforeEach(() => {
    io.callback = null
    io.observed = []
    io.disconnected = 0
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      MockIntersectionObserver
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stays null and observes nothing while disabled (native ghostty)', () => {
    const ref = createRef<HTMLDivElement>()
    ;(ref as { current: HTMLDivElement }).current = document.createElement('div')
    const { result } = renderHook(() => useTerminalOnScreen(ref, false))
    expect(result.current.onScreen).toBe(null)
    expect(io.observed.length).toBe(0)
  })

  it('reports the observed intersection state for an enabled xterm', () => {
    const ref = createRef<HTMLDivElement>()
    ;(ref as { current: HTMLDivElement }).current = document.createElement('div')
    const { result } = renderHook(() => useTerminalOnScreen(ref, true))

    // Observing the real container element, nothing reported yet.
    expect(io.observed.length).toBe(1)
    expect(result.current.onScreen).toBe(null)

    fire(true)
    expect(result.current.onScreen).toBe(true)

    fire(false)
    expect(result.current.onScreen).toBe(false)
  })

  it('assumes on-screen when there is no element to observe', () => {
    const ref = createRef<HTMLDivElement>() // current stays null
    const { result } = renderHook(() => useTerminalOnScreen(ref, true))
    // Cannot measure → never falsely throttle.
    expect(result.current.onScreen).toBe(true)
    expect(io.observed.length).toBe(0)
  })

  it('disconnects the observer when disabled or unmounted', () => {
    const ref = createRef<HTMLDivElement>()
    ;(ref as { current: HTMLDivElement }).current = document.createElement('div')
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useTerminalOnScreen(ref, enabled),
      { initialProps: { enabled: true } }
    )
    expect(io.observed.length).toBe(1)

    rerender({ enabled: false })
    expect(io.disconnected).toBe(1)

    rerender({ enabled: true })
    expect(io.observed.length).toBe(2)

    unmount()
    expect(io.disconnected).toBe(2)
  })

  it('tracks window visibility via document.visibilityState', () => {
    const ref = createRef<HTMLDivElement>()
    ;(ref as { current: HTMLDivElement }).current = document.createElement('div')
    const { result } = renderHook(() => useTerminalOnScreen(ref, true))
    expect(result.current.windowVisible).toBe(true)

    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current.windowVisible).toBe(false)

    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current.windowVisible).toBe(true)
  })
})
