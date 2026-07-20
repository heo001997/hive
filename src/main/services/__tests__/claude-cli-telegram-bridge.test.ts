// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

// The CLI bridge must NOT publish to agentEventBus (that renders the in-app panel).
// Capture any stray publishes to prove the renderer stays isolated from CLI hooks.
const { backendEvents, publishedEvents } = vi.hoisted(() => ({
  backendEvents: [] as Array<{ channel: string; payload: unknown }>,
  publishedEvents: [] as Array<{ type: string; sessionId: string; data: unknown }>
}))
vi.mock('../agent-event-bus', () => ({
  agentEventBus: { publish: (event: { type: string; sessionId: string; data: unknown }) => publishedEvents.push(event) }
}))
vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: (channel: string, payload: unknown) => {
    backendEvents.push({ channel, payload })
    return Promise.resolve()
  }
}))

import { claudeCliTelegramBridge } from '../claude-cli-telegram-bridge'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

/** Minimal fake ServerResponse capturing what the bridge writes. */
function makeRes(): ServerResponse & { body: string | null } {
  const res = {
    writableEnded: false,
    body: null as string | null,
    setTimeout: vi.fn(),
    writeHead: vi.fn(function (this: unknown) {
      return this
    }),
    end: vi.fn(function (this: { writableEnded: boolean; body: string | null }, body?: string) {
      this.writableEnded = true
      this.body = body ?? ''
    }),
    on: vi.fn(),
    removeListener: vi.fn()
  }
  return res as unknown as ServerResponse & { body: string | null }
}

const SESSION = 'cli-session-1'

afterEach(() => {
  claudeCliTelegramBridge.cancelAll()
  backendEvents.length = 0
  publishedEvents.length = 0
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('claudeCliTelegramBridge.onHook (interactive prompts stay in the terminal)', () => {
  it('does not take ownership for an unregistered session', () => {
    const res = makeRes()
    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Plan' } },
      res
    )
    expect(owned).toBe(false)
    expect(res.end).not.toHaveBeenCalled()
    expect(publishedEvents).toHaveLength(0)
  })

  it('does not hold AskUserQuestion so it renders in the native terminal', () => {
    claudeCliTelegramBridge.register(SESSION)
    const res = makeRes()
    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'Pick a language', header: 'Lang', options: [{ label: 'TypeScript' }] }
          ]
        }
      },
      res
    )
    expect(owned).toBe(false)
    expect(res.end).not.toHaveBeenCalled()
    // Never reaches the renderer or the telegram private channel.
    expect(publishedEvents).toHaveLength(0)
    expect(backendEvents).toHaveLength(0)
  })

  it('does not hold ExitPlanMode so the plan menu renders in the native terminal', () => {
    claudeCliTelegramBridge.register(SESSION)
    const events: OpenCodeStreamEvent[] = []
    const unsub = claudeCliTelegramBridge.subscribe((e) => events.push(e))
    const res = makeRes()
    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan' } },
      res
    )
    expect(owned).toBe(false)
    expect(res.setTimeout).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'plan.ready')).toBe(false)
    expect(backendEvents).toHaveLength(0)
    expect(publishedEvents).toHaveLength(0)
    unsub()
  })
})

describe('claudeCliTelegramBridge transcript relay (telegram-only private channel)', () => {
  it('emits assistant text + idle on Stop, never to the renderer', () => {
    const events: OpenCodeStreamEvent[] = []
    const unsub = claudeCliTelegramBridge.subscribe((e) => events.push(e))
    claudeCliTelegramBridge.register(SESSION)

    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'Stop', last_assistant_message: 'All done.' },
      makeRes()
    )
    expect(owned).toBe(false)
    const msg = events.find((e) => e.type === 'message.updated')
    expect((msg!.data as { content: string }).content).toBe('All done.')
    expect(events.some((e) => e.type === 'session.idle')).toBe(true)
    expect(publishedEvents).toHaveLength(0) // never reaches the renderer
    unsub()
  })

  it('emits session.busy on UserPromptSubmit / PostToolUse', () => {
    const events: OpenCodeStreamEvent[] = []
    const unsub = claudeCliTelegramBridge.subscribe((e) => events.push(e))
    claudeCliTelegramBridge.register(SESSION)
    claudeCliTelegramBridge.onHook(SESSION, { hook_event_name: 'UserPromptSubmit' }, makeRes())
    expect(events.some((e) => e.type === 'session.busy')).toBe(true)
    unsub()
  })
})

describe('claudeCliTelegramBridge teardown', () => {
  it('cancelSession unregisters the session and stops relaying', () => {
    const events: OpenCodeStreamEvent[] = []
    const unsub = claudeCliTelegramBridge.subscribe((e) => events.push(e))
    claudeCliTelegramBridge.register(SESSION)
    expect(claudeCliTelegramBridge.isRegistered(SESSION)).toBe(true)

    claudeCliTelegramBridge.cancelSession(SESSION)
    expect(claudeCliTelegramBridge.isRegistered(SESSION)).toBe(false)

    claudeCliTelegramBridge.onHook(SESSION, { hook_event_name: 'UserPromptSubmit' }, makeRes())
    expect(events).toHaveLength(0)
    unsub()
  })
})
