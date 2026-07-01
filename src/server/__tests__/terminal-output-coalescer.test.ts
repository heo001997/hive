import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../../shared/rpc/protocol'
import {
  HIDDEN_TERMINAL_FLUSH_MS,
  MAX_PENDING_TERMINAL_OUTPUT_BYTES
} from '../../shared/types/terminal'
import { makeEventBus } from '../events/event-bus'
import {
  disposeTerminalOutput,
  flushTerminalOutput,
  publishTerminalOutput,
  setTerminalOutputVisible
} from '../rpc/domains/terminal-output-coalescer'

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const microtask = (): Promise<void> => Promise.resolve()

const collect = async (): Promise<{ events: ServerEvent[]; bus: ReturnType<typeof makeEventBus> }> => {
  const bus = makeEventBus()
  const events: ServerEvent[] = []
  await Effect.runPromise(bus.subscribeAll((event) => events.push(event)))
  return { events, bus }
}

describe('terminal output coalescer', () => {
  afterEach(() => {
    vi.useRealTimers()
    // Clear module-scoped state so ids don't bleed across tests.
    for (const id of ['t-visible', 't-hidden', 't-flip', 't-burst', 't-exit']) {
      disposeTerminalOutput(id)
    }
  })

  it('merges within-tick chunks into one message for a visible terminal', async () => {
    const { events, bus } = await collect()

    // Default (no visibility recorded) is visible.
    publishTerminalOutput(bus, 't-visible', 'hel')
    publishTerminalOutput(bus, 't-visible', 'lo')
    expect(events).toEqual([]) // buffered, not yet flushed

    await nextTick()

    expect(events).toEqual([{ channel: 'terminal:data:t-visible', payload: 'hello' }])
  })

  it('holds a hidden terminal until the slow cadence elapses', async () => {
    vi.useFakeTimers()
    const { events, bus } = await collect()

    setTerminalOutputVisible(bus, 't-hidden', false)
    publishTerminalOutput(bus, 't-hidden', 'a')
    publishTerminalOutput(bus, 't-hidden', 'b')

    vi.advanceTimersByTime(HIDDEN_TERMINAL_FLUSH_MS - 1)
    await microtask()
    expect(events).toEqual([])

    vi.advanceTimersByTime(1)
    await microtask()
    expect(events).toEqual([{ channel: 'terminal:data:t-hidden', payload: 'ab' }])
  })

  it('flushes pending output immediately when a terminal becomes visible', async () => {
    vi.useFakeTimers()
    const { events, bus } = await collect()

    setTerminalOutputVisible(bus, 't-flip', false)
    publishTerminalOutput(bus, 't-flip', 'queued')
    expect(events).toEqual([])

    setTerminalOutputVisible(bus, 't-flip', true)
    await microtask()

    expect(events).toEqual([{ channel: 'terminal:data:t-flip', payload: 'queued' }])
  })

  it('flushes a burst over the byte cap immediately regardless of cadence', async () => {
    vi.useFakeTimers()
    const { events, bus } = await collect()

    setTerminalOutputVisible(bus, 't-burst', false)
    publishTerminalOutput(bus, 't-burst', 'x'.repeat(MAX_PENDING_TERMINAL_OUTPUT_BYTES))
    await microtask()

    expect(events).toHaveLength(1)
    expect(events[0].channel).toBe('terminal:data:t-burst')
    expect((events[0].payload as string).length).toBe(MAX_PENDING_TERMINAL_OUTPUT_BYTES)
  })

  it('flush drains buffered output so an exit event can be ordered after it', async () => {
    const { events, bus } = await collect()

    setTerminalOutputVisible(bus, 't-exit', false)
    publishTerminalOutput(bus, 't-exit', 'tail')

    // Simulate the exit path: flush pending output, then publish exit.
    flushTerminalOutput(bus, 't-exit')
    await Effect.runPromise(bus.publish({ channel: 'terminal:exit:t-exit', payload: 0 }))

    expect(events).toEqual([
      { channel: 'terminal:data:t-exit', payload: 'tail' },
      { channel: 'terminal:exit:t-exit', payload: 0 }
    ])
  })
})
