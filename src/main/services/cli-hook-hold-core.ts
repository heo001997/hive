import type { ServerResponse } from 'node:http'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

export interface ClaudeHookBody {
  hook_event_name?: string
  tool_name?: string
  tool_input?: { plan?: unknown; questions?: unknown }
  assistant_message?: string
  last_assistant_message?: string
}

export interface HeldInteractionEvents {
  name: string
  emitTransport: (event: OpenCodeStreamEvent) => void
}

/**
 * Relays a forwarded Claude CLI session's transcript (busy/idle/assistant text)
 * to a transport (Telegram/Discord). Interactive prompts — AskUserQuestion and
 * ExitPlanMode — are deliberately NOT intercepted: they render in the native
 * terminal so the CLI's own selection UI stays where the user is. The hook
 * response is never held open; `onHook` always returns false so the hook server
 * answers immediately and the CLI proceeds to its terminal prompt.
 */
export class CliHookHoldCore {
  private readonly events: HeldInteractionEvents
  private readonly registered = new Set<string>()

  constructor(events: HeldInteractionEvents) {
    this.events = events
  }

  register(sessionId: string): void {
    this.registered.add(sessionId)
  }

  unregister(sessionId: string): void {
    this.registered.delete(sessionId)
  }

  isRegistered(sessionId: string): boolean {
    return this.registered.has(sessionId)
  }

  onHook(sessionId: string, body: ClaudeHookBody, _res: ServerResponse): boolean {
    if (!this.registered.has(sessionId)) return false

    const event = body.hook_event_name
    if (event === 'Stop') {
      this.emitIdle(sessionId, body)
      return false
    }
    if (
      event === 'UserPromptSubmit' ||
      event === 'PostToolUse' ||
      event === 'PostToolUseFailure'
    ) {
      this.events.emitTransport({ type: 'session.busy', sessionId, data: {} })
      return false
    }
    return false
  }

  cancelSession(sessionId: string): void {
    this.unregister(sessionId)
  }

  cancelAll(): void {
    this.registered.clear()
  }

  private emitIdle(sessionId: string, body: ClaudeHookBody): void {
    const text = body.last_assistant_message ?? body.assistant_message
    if (typeof text === 'string' && text.trim().length > 0) {
      this.events.emitTransport({
        type: 'message.updated',
        sessionId,
        data: { role: 'assistant', content: text }
      })
    }
    this.events.emitTransport({ type: 'session.idle', sessionId, data: {} })
  }
}
