import { Effect } from 'effect'
import type { EventBus } from '../../events/event-bus'
import {
  HIDDEN_TERMINAL_FLUSH_MS,
  MAX_PENDING_TERMINAL_OUTPUT_BYTES
} from '../../../shared/types/terminal'

/**
 * Server-side, visibility-aware coalescing of terminal PTY output before it
 * crosses the single renderer WebSocket.
 *
 * Every terminal's PTY output — server-owned shells (terminal-ops) AND the
 * desktop-main claude-cli PTYs (forwarded in server.ts) — funnels through the
 * server event bus and out one shared socket. The renderer JSON.parses every
 * message on its main thread, so a fleet of backgrounded agents each streaming
 * a TUI floods that thread and starves the *focused* terminal's keystroke echo.
 * That is the input lag this coalescer removes.
 *
 * We batch per terminal by visibility:
 *  - visible → flush once per event-loop tick (setImmediate): the many tiny
 *    chunks node-pty delivers within a tick merge into one message, with zero
 *    added latency for the focused terminal.
 *  - hidden → flush at most every HIDDEN_TERMINAL_FLUSH_MS: a backgrounded
 *    agent's output crosses the socket in far fewer, larger messages, cutting
 *    the renderer's main-thread parse load to near nothing.
 *  - either way, a burst exceeding MAX_PENDING_TERMINAL_OUTPUT_BYTES flushes
 *    immediately so server memory can't grow unbounded behind a slow cadence.
 *
 * Visibility is driven by the renderer via terminalOps.setVisible. A terminal
 * with no recorded visibility defaults to visible, so nothing regresses before
 * the first signal arrives (and shell terminals, which never hide, stay on the
 * per-tick path exactly as before).
 */

interface PendingOutput {
  buffer: string
  bytes: number
  immediate: ReturnType<typeof setImmediate> | null
  timer: ReturnType<typeof setTimeout> | null
}

const visibility = new Map<string, boolean>()
const pending = new Map<string, PendingOutput>()

const isVisible = (terminalId: string): boolean => visibility.get(terminalId) ?? true

const publishEvent = (eventBus: EventBus, channel: string, payload: unknown): void => {
  void Effect.runPromise(eventBus.publish({ channel, payload })).catch(() => undefined)
}

const clearTimers = (state: PendingOutput): void => {
  if (state.immediate) {
    clearImmediate(state.immediate)
    state.immediate = null
  }
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
}

/** Emit whatever is buffered for this terminal right now (if anything). */
export const flushTerminalOutput = (
  eventBus: EventBus | undefined,
  terminalId: string
): void => {
  const state = pending.get(terminalId)
  if (!state) return
  clearTimers(state)
  if (state.buffer.length === 0) return
  const data = state.buffer
  state.buffer = ''
  state.bytes = 0
  if (eventBus) publishEvent(eventBus, `terminal:data:${terminalId}`, data)
}

/** Buffer one PTY output chunk and schedule a flush on the visibility cadence. */
export const publishTerminalOutput = (
  eventBus: EventBus | undefined,
  terminalId: string,
  chunk: string
): void => {
  if (!eventBus || chunk.length === 0) return

  const existing = pending.get(terminalId)
  const state: PendingOutput = existing ?? {
    buffer: '',
    bytes: 0,
    immediate: null,
    timer: null
  }
  if (!existing) pending.set(terminalId, state)

  state.buffer += chunk
  state.bytes += chunk.length

  // Burst guard applies regardless of visibility.
  if (state.bytes >= MAX_PENDING_TERMINAL_OUTPUT_BYTES) {
    flushTerminalOutput(eventBus, terminalId)
    return
  }

  if (isVisible(terminalId)) {
    if (state.immediate) return
    state.immediate = setImmediate(() => {
      state.immediate = null
      flushTerminalOutput(eventBus, terminalId)
    })
  } else {
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = null
      flushTerminalOutput(eventBus, terminalId)
    }, HIDDEN_TERMINAL_FLUSH_MS)
  }
}

/**
 * Record a terminal's visibility. Becoming visible flushes at once so the
 * focused terminal shows its current output immediately instead of waiting out
 * the hidden cadence.
 */
export const setTerminalOutputVisible = (
  eventBus: EventBus | undefined,
  terminalId: string,
  visible: boolean
): void => {
  visibility.set(terminalId, visible)
  if (visible) flushTerminalOutput(eventBus, terminalId)
}

/** Drop all coalescer state for a terminal (on PTY exit / destroy / detach). */
export const disposeTerminalOutput = (terminalId: string): void => {
  const state = pending.get(terminalId)
  if (state) {
    clearTimers(state)
    pending.delete(terminalId)
  }
  visibility.delete(terminalId)
}
