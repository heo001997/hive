import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL } from '@shared/telegram-events'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { CliHookHoldCore, type ClaudeHookBody } from './cli-hook-hold-core'

export type { ClaudeHookBody } from './cli-hook-hold-core'

class ClaudeCliTelegramBridge {
  readonly name = 'telegram'
  private readonly emitter = new EventEmitter()
  private readonly core = new CliHookHoldCore({
    name: 'Telegram',
    emitTransport: (event) => this.emitTelegram(event)
  })

  register(sessionId: string): void {
    this.core.register(sessionId)
  }

  isRegistered(sessionId: string): boolean {
    return this.core.isRegistered(sessionId)
  }

  subscribe(listener: (event: OpenCodeStreamEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  onHook(sessionId: string, body: ClaudeHookBody, res: ServerResponse): boolean {
    return this.core.onHook(sessionId, body, res)
  }

  cancelSession(sessionId: string): void {
    this.core.cancelSession(sessionId)
  }

  cancelAll(): void {
    this.core.cancelAll()
  }

  private emitTelegram(event: OpenCodeStreamEvent): void {
    this.emitter.emit('event', event)
    void publishDesktopBackendEvent(TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL, event)
  }
}

export const claudeCliTelegramBridge = new ClaudeCliTelegramBridge()
