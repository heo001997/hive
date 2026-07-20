import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type { ServerEvent } from '@shared/rpc/protocol'
import { makeEventBus } from './event-bus'

const publish = (bus: ReturnType<typeof makeEventBus>, channel: string, payload: unknown): void => {
  Effect.runSync(bus.publish({ channel, payload }))
}

describe('makeEventBus resumable subscriptions', () => {
  it('stamps a monotonic per-channel seq on delivered events', () => {
    const bus = makeEventBus()
    const a: ServerEvent[] = []
    const b: ServerEvent[] = []
    Effect.runSync(bus.subscribe('a', (e) => a.push(e)))
    Effect.runSync(bus.subscribe('b', (e) => b.push(e)))

    publish(bus, 'a', 1)
    publish(bus, 'a', 2)
    publish(bus, 'b', 1)

    expect(a.map((e) => e.seq)).toEqual([1, 2])
    // Sequence is per-channel, so channel b starts back at 1.
    expect(b.map((e) => e.seq)).toEqual([1])
  })

  it('replays only the events after the cursor, in order', () => {
    const bus = makeEventBus()
    publish(bus, 'c', 'one')
    publish(bus, 'c', 'two')
    publish(bus, 'c', 'three')

    const result = Effect.runSync(bus.replay!('c', 1))
    expect(result.gap).toBe(false)
    expect(result.latestSeq).toBe(3)
    expect(result.events.map((e) => e.payload)).toEqual(['two', 'three'])
    expect(result.events.map((e) => e.seq)).toEqual([2, 3])
  })

  it('reports no missed events when the cursor is already current', () => {
    const bus = makeEventBus()
    publish(bus, 'c', 'one')
    publish(bus, 'c', 'two')

    const result = Effect.runSync(bus.replay!('c', 2))
    expect(result.gap).toBe(false)
    expect(result.events).toEqual([])
    expect(result.latestSeq).toBe(2)
  })

  it('signals a gap when the cursor predates the retained window', () => {
    // Tiny buffer so early events are evicted deterministically.
    const bus = makeEventBus({ bufferSize: 2 })
    publish(bus, 'c', 'one') // seq 1, evicted
    publish(bus, 'c', 'two') // seq 2, evicted
    publish(bus, 'c', 'three') // seq 3, retained
    publish(bus, 'c', 'four') // seq 4, retained

    // Cursor at 1 needs seq 2, which was evicted -> gap.
    const gapped = Effect.runSync(bus.replay!('c', 1))
    expect(gapped.gap).toBe(true)
    expect(gapped.events).toEqual([])
    expect(gapped.latestSeq).toBe(4)

    // Cursor at 3 only needs seq 4, still retained -> clean replay.
    const clean = Effect.runSync(bus.replay!('c', 3))
    expect(clean.gap).toBe(false)
    expect(clean.events.map((e) => e.payload)).toEqual(['four'])
  })

  it('bounds retention to bufferSize (no unbounded growth)', () => {
    const bus = makeEventBus({ bufferSize: 3 })
    for (let i = 1; i <= 100; i += 1) publish(bus, 'c', i)

    // Only the last 3 remain; a cursor within them replays, older -> gap.
    const clean = Effect.runSync(bus.replay!('c', 98))
    expect(clean.gap).toBe(false)
    expect(clean.events.map((e) => e.payload)).toEqual([99, 100])

    const gapped = Effect.runSync(bus.replay!('c', 50))
    expect(gapped.gap).toBe(true)
  })

  it('signals a gap when the cursor is ahead of the server (counter reset)', () => {
    const bus = makeEventBus()
    publish(bus, 'c', 'one')

    // Client claims seq 42 but the (fresh) server only issued seq 1 -> resync.
    const result = Effect.runSync(bus.replay!('c', 42))
    expect(result.gap).toBe(true)
    expect(result.latestSeq).toBe(1)
  })

  it('signals a gap for an unknown channel with a non-zero cursor', () => {
    const bus = makeEventBus()
    const known = Effect.runSync(bus.replay!('never-published', 0))
    expect(known.gap).toBe(false)
    expect(known.latestSeq).toBe(0)

    const ahead = Effect.runSync(bus.replay!('never-published', 5))
    expect(ahead.gap).toBe(true)
  })

  it('bounds the number of retained channels via LRU eviction', () => {
    const bus = makeEventBus({ maxChannels: 4 })
    // Publish to far more distinct channels than the cap; each name is unique,
    // mimicking the per-session / per-worktree accumulation that leaked memory.
    for (let i = 0; i < 100; i += 1) publish(bus, `ch-${i}`, i)

    // A retained channel still has state (latestSeq > 0); an evicted one reads
    // like an unknown channel (latestSeq resets to 0).
    let retained = 0
    for (let i = 0; i < 100; i += 1) {
      if (Effect.runSync(bus.replay!(`ch-${i}`, 0)).latestSeq > 0) retained += 1
    }
    expect(retained).toBeLessThanOrEqual(4)

    // The most recently published channels are the ones kept.
    expect(Effect.runSync(bus.replay!('ch-99', 0)).latestSeq).toBe(1)
    expect(Effect.runSync(bus.replay!('ch-0', 0)).latestSeq).toBe(0)
  })

  it('retains a recently-used channel while evicting the least-recently-used', () => {
    const bus = makeEventBus({ maxChannels: 2 })
    publish(bus, 'old', 'x') // channels: [old]
    publish(bus, 'mid', 'y') // channels: [old, mid] — at cap
    publish(bus, 'old', 'x2') // touch 'old' -> [mid, old]; 'mid' is now LRU

    // Creating a 3rd channel exceeds the cap: the LRU 'mid' is evicted, not the
    // recently-touched 'old'.
    publish(bus, 'new', 'z')

    expect(Effect.runSync(bus.replay!('old', 0)).latestSeq).toBe(2) // retained
    expect(Effect.runSync(bus.replay!('mid', 0)).latestSeq).toBe(0) // evicted
    expect(Effect.runSync(bus.replay!('new', 0)).latestSeq).toBe(1) // retained
  })

  it('prefers evicting a channel with no live subscribers over the strict LRU', () => {
    const bus = makeEventBus({ maxChannels: 2 })
    Effect.runSync(bus.subscribe('kept', () => {}))
    publish(bus, 'kept', 'a') // subscribed + published; oldest by recency
    publish(bus, 'transient', 'b') // at cap; no subscribers

    // 'kept' is the strict LRU, but it has a live subscriber, so the
    // subscriber-less 'transient' is chosen as the victim instead.
    publish(bus, 'fresh', 'c')

    expect(Effect.runSync(bus.replay!('kept', 0)).latestSeq).toBe(1) // retained
    expect(Effect.runSync(bus.replay!('transient', 0)).latestSeq).toBe(0) // evicted
    expect(Effect.runSync(bus.replay!('fresh', 0)).latestSeq).toBe(1) // retained
  })
})
