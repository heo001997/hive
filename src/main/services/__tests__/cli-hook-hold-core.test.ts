// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { CliHookHoldCore, type ClaudeHookBody } from '../cli-hook-hold-core'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

function makeRes(): ServerResponse & { body: string | null; close: () => void } {
  let closeHandler: (() => void) | null = null
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
    on: vi.fn((_event: string, handler: () => void) => {
      closeHandler = handler
      return res
    }),
    removeListener: vi.fn(),
    close: () => closeHandler?.()
  }
  return res as unknown as ServerResponse & { body: string | null; close: () => void }
}

const makeCore = () => {
  const transport: OpenCodeStreamEvent[] = []
  const core = new CliHookHoldCore({
    name: 'test',
    emitTransport: (event) => transport.push(event)
  })
  return { core, transport }
}

const SESSION = 'cli-session-1'

describe('CliHookHoldCore', () => {
  it('ignores hooks for sessions that are not registered', () => {
    const { core, transport } = makeCore()
    const res = makeRes()

    expect(
      core.onHook(
        SESSION,
        { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Plan' } },
        res
      )
    ).toBe(false)
    expect(res.setTimeout).not.toHaveBeenCalled()
    expect(transport).toHaveLength(0)
  })

  it('does not hold AskUserQuestion so it renders in the native terminal', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    const res = makeRes()
    const body: ClaudeHookBody = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Pick one', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] }
        ]
      }
    }

    expect(core.onHook(SESSION, body, res)).toBe(false)
    expect(res.setTimeout).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
    expect(transport).toHaveLength(0)
  })

  it('does not hold ExitPlanMode so the plan menu renders in the native terminal', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    const res = makeRes()

    expect(
      core.onHook(
        SESSION,
        { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Plan' } },
        res
      )
    ).toBe(false)
    expect(res.setTimeout).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
    expect(transport.some((event) => event.type === 'plan.ready')).toBe(false)
  })

  it('relays busy on prompt/tool activity for forwarded transcripts', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    const res = makeRes()

    expect(
      core.onHook(SESSION, { hook_event_name: 'UserPromptSubmit' }, res)
    ).toBe(false)
    expect(transport).toEqual([{ type: 'session.busy', sessionId: SESSION, data: {} }])
  })

  it('relays the final assistant message and idle on Stop', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    const res = makeRes()

    expect(
      core.onHook(
        SESSION,
        { hook_event_name: 'Stop', last_assistant_message: 'All done' },
        res
      )
    ).toBe(false)
    expect(transport).toEqual([
      { type: 'message.updated', sessionId: SESSION, data: { role: 'assistant', content: 'All done' } },
      { type: 'session.idle', sessionId: SESSION, data: {} }
    ])
  })

  it('stops relaying once the session is cancelled', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    core.cancelSession(SESSION)
    const res = makeRes()

    expect(core.onHook(SESSION, { hook_event_name: 'UserPromptSubmit' }, res)).toBe(false)
    expect(transport).toHaveLength(0)
  })
})
