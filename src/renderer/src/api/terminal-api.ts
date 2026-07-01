import { getRendererRpcClient } from './rpc-client'
import type {
  TerminalGhosttyAvailabilityResult,
  TerminalGhosttyCreateSurfaceOptions,
  TerminalGhosttyCreateSurfaceResult,
  TerminalGhosttyFocusDiagnosticsResult,
  TerminalGhosttyInitResult,
  TerminalGhosttyKeyEvent,
  TerminalGhosttyRect
} from '@shared/desktop-command'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { Envelope } from '@shared/types/ipc-envelope'
import type { GhosttyTerminalConfig } from '@shared/types/terminal'

export type ClaudeCliSessionStatusType =
  | 'working'
  | 'planning'
  | 'answering'
  | 'permission'
  | 'command_approval'
  | 'unread'
  | 'completed'
  | 'plan_ready'

export interface ClaudeCliStatusPayload {
  readonly sessionId: string
  readonly status: ClaudeCliSessionStatusType
  readonly metadata?: {
    readonly reason?: string
    readonly hookEventName?: string
    readonly hookPath?: string
    readonly toolName?: string
    readonly plan?: string
  }
}

// Offsets (ms) at which to re-send a bare Enter after a Claude CLI prompt paste,
// covering claude's settle window (cold boot or post-resize redraw). Extends one
// step past the main-side SUBMIT_REASSERT_DELAYS_MS in
// src/main/services/claude-cli-pty-prompt.ts because the followup case has a
// wider window — the user often re-opens the ticket a couple seconds after
// sending, which triggers a terminal refit/redraw that can eat the CR.
const FOLLOWUP_SUBMIT_REASSERT_DELAYS_MS = [400, 900, 1600, 2600, 4000] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isClaudeCliStatusPayload = (value: unknown): value is ClaudeCliStatusPayload => {
  if (!isRecord(value)) return false
  if (typeof value.sessionId !== 'string') return false
  if (
    ![
      'working',
      'planning',
      'answering',
      'permission',
      'command_approval',
      'unread',
      'completed',
      'plan_ready'
    ].includes(typeof value.status === 'string' ? value.status : '')
  ) {
    return false
  }

  return value.metadata === undefined || isRecord(value.metadata)
}

export const terminalApi = {
  create: async (
    terminalId: string,
    cwd: string,
    shell?: string
  ): Promise<Envelope<{ success: boolean; cols?: number; rows?: number; error?: string }>> => {
    const result = await getRendererRpcClient().request<{
      success: boolean
      cols?: number
      rows?: number
      error?: string
    }>('terminalOps.create', { terminalId, cwd, shell })
    return { success: true, value: result }
  },
  createClaudeCli: async (
    sessionId: string,
    opts?: { pendingPrompt?: string | null }
  ): Promise<Envelope<{ success: boolean; cols?: number; rows?: number; error?: string }>> => {
    const result = await getRendererRpcClient().request<{
      success: boolean
      cols?: number
      rows?: number
      error?: string
    }>('terminalOps.createClaudeCli', { sessionId, opts })
    return { success: true, value: result }
  },
  sendClaudeCliPrompt: async (
    sessionId: string,
    prompt: string
  ): Promise<Envelope<{ delivered: boolean }>> => {
    try {
      await getRendererRpcClient().request<void>('terminalOps.write', {
        terminalId: sessionId,
        data: `\x1b[200~${prompt}\x1b[201~\r`
      })
      // The bracketed paste can land while claude's TUI isn't input-ready —
      // either still booting, or mid-redraw because the user just re-opened the
      // ticket and the terminal refit/resized. claude then buffers the pasted
      // text but silently drops the submitting CR, so the prompt sits in the
      // input box and the turn never starts (ticket reads "In Progress" yet the
      // terminal hasn't moved). Re-assert a bare Enter across the settle window
      // so the already-buffered text actually submits. A CR on empty/idle input
      // is a harmless no-op, so the fixed schedule is safe. Mirrors the
      // main-side reassertClaudeCliPromptSubmit used on the create/handoff path.
      for (const ms of FOLLOWUP_SUBMIT_REASSERT_DELAYS_MS) {
        setTimeout(() => {
          void getRendererRpcClient()
            .request<void>('terminalOps.write', { terminalId: sessionId, data: '\r' })
            .catch(() => undefined)
        }, ms)
      }
      return { success: true, value: { delivered: true } }
    } catch {
      return { success: true, value: { delivered: false } }
    }
  },
  destroy: async (terminalId: string): Promise<Envelope<void>> => {
    await getRendererRpcClient().request<void>('terminalOps.destroy', { terminalId })
    return { success: true, value: undefined }
  },
  write: (terminalId: string, data: string): void => {
    void getRendererRpcClient()
      .request<void>('terminalOps.write', { terminalId, data })
      .catch(() => undefined)
  },
  resize: async (terminalId: string, cols: number, rows: number): Promise<Envelope<void>> => {
    await getRendererRpcClient().request<void>('terminalOps.resize', { terminalId, cols, rows })
    return { success: true, value: undefined }
  },
  /**
   * Fire-and-forget hint telling the server whether this terminal is on-screen.
   * The server uses it only to pick its output-coalescing cadence: a hidden
   * terminal's PTY output is batched (~HIDDEN_TERMINAL_FLUSH_MS) so backgrounded
   * agents don't flood the single WebSocket and starve the focused terminal's
   * keystroke echo.
   */
  setVisible: (terminalId: string, visible: boolean): void => {
    void getRendererRpcClient()
      .request<void>('terminalOps.setVisible', { terminalId, visible })
      .catch(() => undefined)
  },
  onData: (terminalId: string, callback: (data: string) => void): (() => void) => {
    return getRendererRpcClient().subscribe(`terminal:data:${terminalId}`, (event: ServerEvent) => {
      if (typeof event.payload === 'string') callback(event.payload)
    })
  },
  onExit: (terminalId: string, callback: (code: number) => void): (() => void) => {
    return getRendererRpcClient().subscribe(`terminal:exit:${terminalId}`, (event: ServerEvent) => {
      if (typeof event.payload === 'number') callback(event.payload)
    })
  },
  onClaudeSessionId: (
    sessionId: string,
    callback: (claudeSessionId: string) => void
  ): (() => void) => {
    return getRendererRpcClient().subscribe(
      `terminal:claude-session-id:${sessionId}`,
      (event: ServerEvent) => {
        if (typeof event.payload === 'string') callback(event.payload)
      }
    )
  },
  onClaudeCliStatus: (callback: (payload: ClaudeCliStatusPayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe('claude-cli:status', (event: ServerEvent) => {
      if (isClaudeCliStatusPayload(event.payload)) callback(event.payload)
    })
  },
  ghosttyPasteText: async (terminalId: string, text: string): Promise<Envelope<void>> => {
    await getRendererRpcClient().request<void>('terminalOps.ghosttyPasteText', { terminalId, text })
    return { success: true, value: undefined }
  },
  ghosttyFocusDiagnostics: async (): Promise<TerminalGhosttyFocusDiagnosticsResult> => {
    return getRendererRpcClient().request<TerminalGhosttyFocusDiagnosticsResult>(
      'terminalOps.ghosttyFocusDiagnostics',
      {}
    )
  },
  getConfig: async (): Promise<Envelope<GhosttyTerminalConfig>> => {
    const config = await getRendererRpcClient().request<GhosttyTerminalConfig>(
      'terminalOps.getConfig',
      {}
    )
    return { success: true, value: config }
  },
  /**
   * Fire-and-forget: persist renderer-side terminal diagnostics (font
   * resolution, renderer fallback, fitted dimensions) into the main-process
   * log so support reports from affected machines include them.
   */
  logClientDiagnostics: (event: string, data: Record<string, unknown>): void => {
    void getRendererRpcClient()
      .request<void>('terminalOps.logDiagnostics', { event, data })
      .catch(() => {})
  },
  ghosttyIsAvailable: async (): Promise<TerminalGhosttyAvailabilityResult> => {
    return getRendererRpcClient().request<TerminalGhosttyAvailabilityResult>(
      'terminalOps.ghosttyIsAvailable',
      {}
    )
  },
  ghosttyInit: async (): Promise<TerminalGhosttyInitResult> => {
    return getRendererRpcClient().request<TerminalGhosttyInitResult>('terminalOps.ghosttyInit', {})
  },
  ghosttyCreateSurface: async (
    terminalId: string,
    rect: TerminalGhosttyRect,
    opts?: TerminalGhosttyCreateSurfaceOptions
  ): Promise<TerminalGhosttyCreateSurfaceResult> => {
    return getRendererRpcClient().request<TerminalGhosttyCreateSurfaceResult>(
      'terminalOps.ghosttyCreateSurface',
      {
        terminalId,
        rect,
        opts
      }
    )
  },
  ghosttyDestroySurface: async (terminalId: string): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyDestroySurface', {
      terminalId
    })
  },
  ghosttyShutdown: async (): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyShutdown', {})
  },
  ghosttySetFocus: async (terminalId: string, focused: boolean): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttySetFocus', {
      terminalId,
      focused
    })
  },
  ghosttySetFrame: async (terminalId: string, rect: TerminalGhosttyRect): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttySetFrame', {
      terminalId,
      rect
    })
  },
  ghosttySetSize: async (terminalId: string, width: number, height: number): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttySetSize', {
      terminalId,
      width,
      height
    })
  },
  ghosttyKeyEvent: async (terminalId: string, event: TerminalGhosttyKeyEvent): Promise<boolean> => {
    return getRendererRpcClient().request<boolean>('terminalOps.ghosttyKeyEvent', {
      terminalId,
      event
    })
  },
  ghosttyMouseButton: async (
    terminalId: string,
    state: number,
    button: number,
    mods: number
  ): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyMouseButton', {
      terminalId,
      state,
      button,
      mods
    })
  },
  ghosttyMousePos: async (
    terminalId: string,
    x: number,
    y: number,
    mods: number
  ): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyMousePos', {
      terminalId,
      x,
      y,
      mods
    })
  },
  ghosttyMouseScroll: async (
    terminalId: string,
    dx: number,
    dy: number,
    mods: number
  ): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyMouseScroll', {
      terminalId,
      dx,
      dy,
      mods
    })
  }
}
