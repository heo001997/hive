import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XtermBackend, HIDDEN_SCROLLBACK, DEFAULT_SCROLLBACK } from './XtermBackend'
import type { TerminalBackendCallbacks, TerminalOpts } from './types'

// Capture the most recently constructed mock Terminal so tests can read the
// scrollback it was created with and observe runtime `options.scrollback` writes.
const h = vi.hoisted(() => ({ last: null as { options: Record<string, unknown> } | null }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    rows = 24
    buffer = { active: { baseY: 0, getLine: () => ({ translateToString: () => '' }) } }
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts }
      h.last = this as unknown as { options: Record<string, unknown> }
    }
    attachCustomKeyEventHandler = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    clear = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    clearTextureAtlas = vi.fn()
    refresh = vi.fn()
    hasSelection = vi.fn(() => false)
    getSelection = vi.fn(() => '')
    clearSelection = vi.fn()
    input = vi.fn()
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): undefined {
      return undefined
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    clearDecorations(): void {}
  }
}))
vi.mock('@/api/project-api', () => ({
  projectApi: { openPath: vi.fn(() => Promise.resolve()), readFromClipboard: vi.fn(() => Promise.resolve('')) }
}))
vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    write: vi.fn(),
    resize: vi.fn(() => Promise.resolve({})),
    create: vi.fn(() => Promise.resolve({ success: true })),
    logClientDiagnostics: vi.fn()
  }
}))
vi.mock('@/lib/ipc-envelope', () => ({ unwrapEnvelope: (x: unknown) => x }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

const callbacks: TerminalBackendCallbacks = { onStatusChange: vi.fn() }

function mountBackend(opts: Partial<TerminalOpts>): { backend: XtermBackend; container: HTMLDivElement } {
  const backend = new XtermBackend()
  const container = document.createElement('div')
  backend.mount(
    container,
    {
      terminalId: 't1',
      cwd: '/tmp',
      createTerminal: vi.fn(() => Promise.resolve({ success: true })) as TerminalOpts['createTerminal'],
      ...opts
    },
    callbacks
  )
  return { backend, container }
}

describe('XtermBackend scrollback gating', () => {
  beforeEach(() => {
    h.last = null
    // jsdom has no ResizeObserver; XtermBackend constructs one in mount().
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('mounts a hidden terminal with the trimmed scrollback, not the full buffer', () => {
    mountBackend({ initialVisible: false, scrollback: DEFAULT_SCROLLBACK })
    expect(h.last?.options.scrollback).toBe(HIDDEN_SCROLLBACK)
    expect(h.last?.options.cursorBlink).toBe(false)
  })

  it('mounts a visible terminal with the full configured scrollback', () => {
    mountBackend({ initialVisible: true, scrollback: DEFAULT_SCROLLBACK })
    expect(h.last?.options.scrollback).toBe(DEFAULT_SCROLLBACK)
    expect(h.last?.options.cursorBlink).toBe(true)
  })

  it('defaults to DEFAULT_SCROLLBACK when no scrollback is configured', () => {
    mountBackend({ initialVisible: true })
    expect(h.last?.options.scrollback).toBe(DEFAULT_SCROLLBACK)
  })

  it('trims scrollback on hide and restores it on show', () => {
    const { backend } = mountBackend({ initialVisible: true, scrollback: DEFAULT_SCROLLBACK })
    expect(h.last?.options.scrollback).toBe(DEFAULT_SCROLLBACK)

    backend.setVisible(false)
    expect(h.last?.options.scrollback).toBe(HIDDEN_SCROLLBACK)

    backend.setVisible(true)
    expect(h.last?.options.scrollback).toBe(DEFAULT_SCROLLBACK)
  })

  it('never raises scrollback above the configured full value when hiding', () => {
    const small = 500
    const { backend } = mountBackend({ initialVisible: true, scrollback: small })
    expect(h.last?.options.scrollback).toBe(small)

    backend.setVisible(false)
    // min(full, HIDDEN_SCROLLBACK) — stays at 500, not bumped up to 1000.
    expect(h.last?.options.scrollback).toBe(small)
  })
})
