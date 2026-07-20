import { Effect } from 'effect'
import type { ServerEvent } from '@shared/rpc/protocol'

export type ServerEventListener = (event: ServerEvent) => void
export type Unsubscribe = () => void

/**
 * Result of a resumable-subscription replay request.
 *
 * - `gap: false` — every event the caller missed (`seq > sinceSeq`) is still in
 *   the buffer and is returned, in order, as `events`.
 * - `gap: true` — the caller's cursor is older than the retained window (its
 *   missed events were evicted) or ahead of the current sequence (e.g. the
 *   server restarted and reset the counter). `events` is empty; the caller must
 *   emit a resync signal so the client refetches state. `latestSeq` is the
 *   newest sequence known for the channel and should become the client's new
 *   cursor.
 */
export interface ReplayResult {
  readonly events: readonly ServerEvent[]
  readonly gap: boolean
  readonly latestSeq: number
}

export interface EventBus {
  readonly publish: (event: ServerEvent) => Effect.Effect<void>
  readonly subscribe: (channel: string, listener: ServerEventListener) => Effect.Effect<Unsubscribe>
  readonly subscribeAll: (listener: ServerEventListener) => Effect.Effect<Unsubscribe>
  /**
   * Compute the buffered events a (re)subscribing client missed since
   * `sinceSeq`. Pure/synchronous read of the in-memory ring buffer.
   *
   * Optional: buses that do not buffer (test mocks, alternative transports)
   * omit it. Such buses also never stamp `seq`, so clients never accumulate a
   * cursor and never send `sinceSeq` — the server-side replay path is never
   * reached for them.
   */
  readonly replay?: (channel: string, sinceSeq: number) => Effect.Effect<ReplayResult>
}

export interface EventBusOptions {
  /**
   * Per-channel ring-buffer capacity. Caps in-memory retention so a hot channel
   * cannot grow memory without bound: at most `bufferSize` recent events are
   * kept per channel, older ones are evicted. Defaults to 512.
   */
  readonly bufferSize?: number
  /**
   * Maximum number of distinct channels whose state (seq + ring buffer) is
   * retained. Channel names are effectively unbounded over a long-lived process
   * (per-session / per-worktree names accumulate), so without a cap the
   * channels map — and its ring buffers — would grow forever even after every
   * listener unsubscribes. When creating a new channel would exceed this cap,
   * the least-recently-used channel is evicted (its ring buffer dropped),
   * bounding total memory to roughly `maxChannels * bufferSize` events while
   * preserving replay for recently-active channels. Defaults to 4096.
   */
  readonly maxChannels?: number
}

interface ChannelState {
  /** Newest sequence assigned on this channel (0 = nothing published yet). */
  seq: number
  /** Ring buffer of recent stamped events, oldest first, capped at bufferSize. */
  readonly buffer: ServerEvent[]
}

const DEFAULT_BUFFER_SIZE = 512
const DEFAULT_MAX_CHANNELS = 4096

export const makeEventBus = (options: EventBusOptions = {}): EventBus => {
  const bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER_SIZE)
  const maxChannels = Math.max(1, options.maxChannels ?? DEFAULT_MAX_CHANNELS)
  const listeners = new Map<string, Set<ServerEventListener>>()
  const allListeners = new Set<ServerEventListener>()
  // Insertion order doubles as recency order: the first key is the
  // least-recently-used channel, the last key the most-recently-used.
  const channels = new Map<string, ChannelState>()

  // Mark a channel as most-recently-used by moving it to the end of the map's
  // insertion order (delete + re-insert is O(1) amortised).
  const touchChannel = (channel: string, state: ChannelState): void => {
    channels.delete(channel)
    channels.set(channel, state)
  }

  // Make room for one new channel by evicting the least-recently-used one.
  // Prefer a victim with no live subscribers so we never drop replay state out
  // from under an actively-subscribed channel; only when every retained channel
  // has a live subscriber do we fall back to the strict LRU (oldest) victim.
  const evictLruIfNeeded = (): void => {
    if (channels.size < maxChannels) return
    let victim: string | undefined
    for (const key of channels.keys()) {
      if (!listeners.get(key)?.size) {
        victim = key
        break
      }
    }
    if (victim === undefined) victim = channels.keys().next().value
    if (victim !== undefined) channels.delete(victim)
  }

  const getChannelState = (channel: string): ChannelState => {
    let state = channels.get(channel)
    if (!state) {
      evictLruIfNeeded()
      state = { seq: 0, buffer: [] }
      channels.set(channel, state)
      return state
    }
    // Existing channel: refresh its recency so hot channels survive eviction.
    touchChannel(channel, state)
    return state
  }

  return {
    publish: (event) =>
      Effect.sync(() => {
        const state = getChannelState(event.channel)
        state.seq += 1
        // Stamp the event with its per-channel sequence. Callers pass
        // `{ channel, payload }`; we own seq assignment so it stays monotonic.
        const stamped: ServerEvent = { ...event, seq: state.seq }

        state.buffer.push(stamped)
        // Bound retention: evict oldest once we exceed the cap.
        if (state.buffer.length > bufferSize) state.buffer.shift()

        for (const listener of listeners.get(stamped.channel) ?? []) {
          listener(stamped)
        }
        for (const listener of allListeners) {
          listener(stamped)
        }
      }),
    subscribe: (channel, listener) =>
      Effect.sync(() => {
        let channelListeners = listeners.get(channel)
        if (!channelListeners) {
          channelListeners = new Set()
          listeners.set(channel, channelListeners)
        }
        channelListeners.add(listener)

        return () => {
          channelListeners.delete(listener)
          if (channelListeners.size === 0) listeners.delete(channel)
        }
      }),
    subscribeAll: (listener) =>
      Effect.sync(() => {
        allListeners.add(listener)
        return () => {
          allListeners.delete(listener)
        }
      }),
    replay: (channel, sinceSeq) =>
      Effect.sync(() => {
        const state = channels.get(channel)
        if (!state) {
          // Nothing has ever been published on this channel. A client resuming
          // from seq 0 (its baseline) has missed nothing; anything higher means
          // its cursor is ahead of us (fresh server) — signal a gap to be safe.
          return { events: [], gap: sinceSeq > 0, latestSeq: 0 }
        }

        // Cursor already at or beyond the newest sequence: no missed events.
        if (sinceSeq >= state.seq) {
          // Strictly ahead means the client saw a sequence we never issued
          // (counter reset) — force a resync.
          return { events: [], gap: sinceSeq > state.seq, latestSeq: state.seq }
        }

        const oldestRetained = state.buffer[0]?.seq
        // The buffer holds a contiguous tail of sequences. If the client's next
        // needed sequence (sinceSeq + 1) predates the oldest retained event,
        // the gap between them was evicted — resync.
        if (oldestRetained === undefined || sinceSeq + 1 < oldestRetained) {
          return { events: [], gap: true, latestSeq: state.seq }
        }

        const events = state.buffer.filter((event) => (event.seq ?? 0) > sinceSeq)
        return { events, gap: false, latestSeq: state.seq }
      })
  }
}
