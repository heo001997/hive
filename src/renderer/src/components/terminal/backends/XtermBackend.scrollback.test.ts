import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XtermBackend, HIDDEN_SCROLLBACK, DEFAULT_SCROLLBACK } from './XtermBackend'
import type { TerminalBackendCallbacks, TerminalOpts } from './types'
import { terminalApi } from '@/api/terminal-api'

// Capture the most recently constructed mock Terminal so tests can read the
// scrollback it was created with and observe runtime `options.scrollback` writes.
const h = vi.hoisted(() => ({ last: null as { options: Record<string, unknown> } | null }))

// Track every WebglAddon ever constructed and whether it's been disposed, so
// tests can assert the WebGL renderer is loaded only while visible.
const webgl = vi.hoisted(() => ({ instances: [] as Array<{ disposed: boolean }> }))

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
    disposed = false
    constructor() {
      webgl.instances.push(this)
    }
    onContextLoss(): void {}
    dispose(): void {
      this.disposed = true
    }
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
    setVisible: vi.fn(),
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
      createTerminal: vi.fn(() =>
        Promise.resolve({ success: true })
      ) as unknown as TerminalOpts['createTerminal'],
      ...opts
    },
    callbacks
  )
  return { backend, container }
}

describe('XtermBackend scrollback gating', () => {
  beforeEach(() => {
    h.last = null
    webgl.instances.length = 0
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

describe('XtermBackend WebGL gating', () => {
  const active = (): number => webgl.instances.filter((w) => !w.disposed).length

  beforeEach(() => {
    h.last = null
    webgl.instances.length = 0
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not load WebGL when mounted hidden', () => {
    mountBackend({ initialVisible: false })
    expect(webgl.instances.length).toBe(0)
    expect(active()).toBe(0)
  })

  it('loads WebGL when mounted visible', () => {
    mountBackend({ initialVisible: true })
    expect(active()).toBe(1)
  })

  it('drops WebGL on hide and reloads it on show', () => {
    const { backend } = mountBackend({ initialVisible: true })
    expect(active()).toBe(1)

    backend.setVisible(false)
    expect(active()).toBe(0) // GL context + glyph atlas freed while hidden

    backend.setVisible(true)
    expect(active()).toBe(1) // a fresh context is loaded on becoming visible
    expect(webgl.instances.length).toBe(2)
  })

  it('loads WebGL on first show for a terminal mounted hidden', () => {
    const { backend } = mountBackend({ initialVisible: false })
    expect(active()).toBe(0)

    backend.setVisible(true)
    expect(active()).toBe(1)
  })

  it('disposes the WebGL addon on dispose()', () => {
    const { backend } = mountBackend({ initialVisible: true })
    expect(active()).toBe(1)

    backend.dispose()
    expect(active()).toBe(0)
  })
})

describe('XtermBackend hidden-output parse deferral', () => {
  beforeEach(() => {
    h.last = null
    webgl.instances.length = 0
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // The PTY-output callback the backend registered via terminalApi.onData.
  const outputCallback = (): ((data: string) => void) => {
    const calls = vi.mocked(terminalApi.onData).mock.calls
    const cb = calls[calls.length - 1]?.[1]
    if (!cb) throw new Error('onData callback not registered')
    return cb as (data: string) => void
  }

  // The most recently constructed mock Terminal, exposing its write() spy.
  const term = (): { write: ReturnType<typeof vi.fn> } =>
    h.last as unknown as { write: ReturnType<typeof vi.fn> }

  it('does not parse PTY output to xterm while hidden', () => {
    mountBackend({ initialVisible: false })
    outputCallback()('backgrounded agent output')
    // A hidden terminal must not parse on the shared renderer thread: no frame
    // flush, no timer. The bytes stay buffered until the tab is shown/scraped.
    expect(term().write).not.toHaveBeenCalled()
  })

  it('flushes buffered hidden output as one coalesced write when shown', () => {
    const { backend } = mountBackend({ initialVisible: false })
    const cb = outputCallback()
    cb('chunk-a ')
    cb('chunk-b')
    expect(term().write).not.toHaveBeenCalled()

    backend.setVisible(true)
    // Becoming visible flushes synchronously: the buffered chunks parse once.
    expect(term().write).toHaveBeenCalledWith('chunk-a chunk-b')
  })

  it('flushes buffered hidden output on readScreen without a show', () => {
    const { backend } = mountBackend({ initialVisible: false })
    outputCallback()('plan-menu contents')
    // readScreen (plan-menu scraping) drains the buffer so callers see the live
    // screen even while the terminal is hidden.
    backend.readScreen()
    expect(term().write).toHaveBeenCalledWith('plan-menu contents')
  })
})
