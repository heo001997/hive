import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import type { TerminalBackend, TerminalOpts, TerminalBackendCallbacks } from './types'
import { DEFAULT_XTERM_FONT_STACK } from './terminal-fonts'
import { projectApi } from '@/api/project-api'
import { terminalApi } from '@/api/terminal-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { GhosttyTerminalConfig } from '@shared/types/terminal'

/** Default Catppuccin Mocha theme used when no Ghostty config is found */
const DEFAULT_TERMINAL_THEME: ITheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b7066',
  selectionForeground: '#cdd6f4',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8'
}

/** Hard cap on buffered-but-unwritten output. A burst this large flushes
 *  immediately regardless of cadence, so memory can't grow unbounded (e.g. the
 *  app window is backgrounded — rAF paused — while an agent keeps streaming). */
const MAX_PENDING_BYTES = 1_000_000

/** Scrollback (lines) retained while a terminal is HIDDEN. Every tab across
 *  every worktree is kept mounted to preserve PTY state (see TerminalManager),
 *  so N live terminals each holding the full scrollback multiply: an xterm
 *  buffer is (rows + scrollback) lines × cols cells × ~12 bytes/cell, i.e. a
 *  10k-line × 200-col buffer is ~24 MB — times a dozen backgrounded agents that
 *  is hundreds of MB of renderer RSS. Trimming hidden terminals to a small
 *  buffer (xterm frees the dropped lines when `options.scrollback` shrinks) caps
 *  that multiplication: only the one visible terminal keeps full history, the
 *  rest cost ~HIDDEN_SCROLLBACK lines each. Restored on becoming visible — the
 *  lines trimmed while hidden are gone, but recent output and all new output are
 *  kept, which is what a backgrounded agent terminal actually needs. */
export const HIDDEN_SCROLLBACK = 1000

/** Full scrollback used when no Ghostty `scrollback-limit` is configured. */
export const DEFAULT_SCROLLBACK = 10000

/** ANSI color index to xterm.js theme key mapping (0-15) */
const PALETTE_KEYS: (keyof ITheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

/**
 * Resolve a CSS custom property from the :root element.
 */
function getCSSVar(name: string): string | undefined {
  const val = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  return val || undefined
}

/**
 * Map app theme + Ghostty config to an xterm.js ITheme.
 */
function buildTheme(ghosttyConfig: GhosttyTerminalConfig): ITheme {
  const theme: ITheme = { ...DEFAULT_TERMINAL_THEME }

  if (ghosttyConfig.palette) {
    for (const [indexStr, color] of Object.entries(ghosttyConfig.palette)) {
      const index = parseInt(indexStr, 10)
      if (index >= 0 && index < 16 && PALETTE_KEYS[index]) {
        ;(theme as Record<string, string>)[PALETTE_KEYS[index] as string] = String(color)
      }
    }
  }

  if (ghosttyConfig.foreground) theme.foreground = ghosttyConfig.foreground
  if (ghosttyConfig.cursorColor) theme.cursor = ghosttyConfig.cursorColor
  if (ghosttyConfig.selectionBackground)
    theme.selectionBackground = ghosttyConfig.selectionBackground
  if (ghosttyConfig.selectionForeground)
    theme.selectionForeground = ghosttyConfig.selectionForeground

  const bg = getCSSVar('background')
  const fg = getCSSVar('foreground')
  const mutedFg = getCSSVar('muted-foreground')

  if (bg) theme.background = bg
  if (fg && !ghosttyConfig.foreground) theme.foreground = fg
  if (!ghosttyConfig.selectionBackground) {
    const accent = getCSSVar('accent')
    if (accent) theme.selectionBackground = accent
  }
  if (mutedFg && !ghosttyConfig.cursorColor) {
    theme.cursor = mutedFg
  }

  return theme
}

/**
 * Shortcuts that should pass through to Electron / the app, not be consumed by xterm.
 */
function isAppShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey && !e.ctrlKey) return false

  if (e.metaKey && e.key === ',') return true
  if (e.metaKey && e.key === 'q') return true
  if (e.metaKey && e.key === 'w') return true
  if (e.metaKey && e.key === 'h' && !e.shiftKey) return true
  if (e.metaKey && e.key === 'm') return true
  if (e.metaKey && e.key === 'n') return true
  if (e.metaKey && e.key === 'p') return true
  if (e.metaKey && e.shiftKey && e.key === 'P') return true
  if (e.metaKey && (e.key === '[' || e.key === ']')) return true

  // Ctrl+Tab / Ctrl+Shift+Tab — terminal tab cycling handled by the app
  if (e.ctrlKey && e.key === 'Tab') return true

  return false
}

/**
 * xterm.js-based terminal backend. Cross-platform.
 * Uses node-pty on the main process side for shell I/O.
 */
export class XtermBackend implements TerminalBackend {
  readonly type = 'xterm' as const
  readonly supportsSearch = true

  private terminal: Terminal | null = null
  private fitAddon: FitAddon | null = null
  private searchAddon: SearchAddon | null = null
  /** WebGL renderer addon. Loaded only while visible (see loadWebgl/setVisible);
   *  null while hidden or when WebGL is unavailable / the DOM fallback is active. */
  private webglAddon: WebglAddon | null = null
  private resizeObserver: ResizeObserver | null = null
  private removeDataListener: (() => void) | null = null
  private removeExitListener: (() => void) | null = null
  private inputDisposable: { dispose: () => void } | null = null
  private container: HTMLDivElement | null = null
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastSyncedCols = 0
  private lastSyncedRows = 0
  private rendererKind: 'webgl' | 'dom' = 'dom'
  private terminalId: string = ''
  private shiftEnterAsNewline = false
  private ghosttyConfig: GhosttyTerminalConfig = {}
  /** Full scrollback for the visible terminal; hidden terminals are trimmed to
   *  HIDDEN_SCROLLBACK (capped at this so we never *grow* scrollback on hide). */
  private fullScrollback = DEFAULT_SCROLLBACK

  /**
   * Visibility gate. A hidden terminal does NOT parse its PTY stream at all: its
   * output accumulates as raw chunks and is written to xterm only when the tab
   * becomes visible, when its screen is scraped (readScreen), or when the burst
   * guard trips. With many concurrent agents each streaming a TUI, parsing every
   * backgrounded terminal on the single renderer thread — even coalesced to a
   * slow cadence — is the dominant render-lag cost; deferring it keeps the thread
   * free for the focused terminal's echo and repaint. Hidden terminals also stop
   * the cursor-blink render timer and drop WebGL (see setVisible).
   */
  private visible = true
  /**
   * Coalesced PTY output. node-pty delivers many tiny chunks; writing each one
   * separately schedules a render per chunk. We batch the chunks that arrive
   * within a frame (visible) into one write; while hidden we buffer them
   * unparsed until the terminal is shown / scraped / the burst guard trips.
   */
  private pendingWrites: string[] = []
  private pendingBytes = 0
  private flushRaf: number | null = null

  /** Callback for the host to wire Cmd+F search toggling */
  onSearchToggle?: () => void
  /** Callback for the host to wire Cmd+K clear */
  onClearRequest?: () => void

  mount(container: HTMLDivElement, opts: TerminalOpts, callbacks: TerminalBackendCallbacks): void {
    this.terminalId = opts.terminalId
    this.shiftEnterAsNewline = opts.shiftEnterAsNewline ?? false
    // Seed visibility so a backend recreated while its tab is hidden (cwd/font
    // change, StrictMode double-mount) starts gated instead of blinking + writing
    // at full rate behind a hidden panel.
    this.visible = opts.initialVisible ?? true
    this.container = container
    container.innerHTML = ''
    this.fullScrollback = opts.scrollback ?? DEFAULT_SCROLLBACK

    // Store config for theme rebuilding
    this.ghosttyConfig = {
      fontFamily: opts.fontFamily,
      fontSize: opts.fontSize,
      cursorStyle: opts.cursorStyle,
      scrollbackLimit: opts.scrollback,
      shell: opts.shell
    }

    const terminal = new Terminal({
      fontFamily: opts.fontFamily || DEFAULT_XTERM_FONT_STACK,
      fontSize: opts.fontSize || 13,
      lineHeight: 1.2,
      cursorStyle: opts.cursorStyle || 'block',
      // Blink only while visible — a hidden terminal's blink timer is pure waste
      // and, across many backgrounded agent terminals, a constant CPU drain.
      cursorBlink: this.visible,
      // Seed scrollback for the current visibility so a terminal mounted hidden
      // (TerminalManager keeps every tab mounted) never allocates the full
      // buffer; setVisible() trims/restores it as visibility changes.
      scrollback: this.scrollbackForVisibility(this.visible),
      allowProposedApi: true,
      theme: buildTheme(this.ghosttyConfig)
    })

    // Custom key event handler
    terminal.attachCustomKeyEventHandler((e) => {
      if (
        this.shiftEnterAsNewline &&
        e.type === 'keydown' &&
        (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        terminal.input('\x1b\r', true)
        return false
      }

      if (isAppShortcut(e)) return false

      if (e.metaKey && e.key === 'f' && e.type === 'keydown') {
        this.onSearchToggle?.()
        return false
      }

      if (e.metaKey && e.key === 'k' && e.type === 'keydown') {
        terminal.clear()
        this.onClearRequest?.()
        return false
      }

      // Cmd+C — copy if selection, otherwise SIGINT
      if (e.metaKey && e.key === 'c' && !e.shiftKey && e.type === 'keydown') {
        if (terminal.hasSelection()) {
          void copyTextToClipboard(terminal.getSelection())
          terminal.clearSelection()
          return false
        }
        return true
      }

      // Cmd+Shift+C — always copy
      if (e.metaKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        if (terminal.hasSelection()) {
          void copyTextToClipboard(terminal.getSelection())
          terminal.clearSelection()
        }
        return false
      }

      // Cmd+Shift+V — always paste
      if (e.metaKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
        navigator.clipboard
          .readText()
          .catch(() => projectApi.readFromClipboard())
          .then((text) => {
            if (text) terminalApi.write(this.terminalId, text)
          })
          .catch((err) => console.error('Terminal paste failed:', err))
        return false
      }

      return true
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)
    this.searchAddon = searchAddon

    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      projectApi.openPath(uri).catch(console.error)
    })
    terminal.loadAddon(webLinksAddon)

    terminal.open(container)

    // The WebGL renderer (a WebGL2 context + a rasterized glyph texture atlas) is
    // the dominant *fixed* per-terminal memory cost — ~6-15 MB regardless of
    // scrollback, so the #106 buffer trim doesn't touch it. Every tab across every
    // worktree is kept mounted to preserve PTY state, so N live terminals each
    // pinning a GL context both multiplies that cost and blows past the browser's
    // ~16 live-context cap (the 17th eviction thrashes terminals between renderers).
    // Only the *visible* terminal needs WebGL: load it here only when visible and
    // load/drop it on visibility change (see setVisible). A hidden-mounted terminal
    // renders on xterm's cheaper DOM renderer until first shown.
    if (this.visible) this.loadWebgl(terminal)

    try {
      fitAddon.fit()
    } catch {
      // Container might not be visible yet
    }

    this.terminal = terminal
    this.fitAddon = fitAddon

    // Wire user input -> PTY
    this.inputDisposable = terminal.onData((data) => {
      terminalApi.write(this.terminalId, data)
    })

    // Wire PTY output -> terminal display (coalesced; see enqueueWrite)
    this.removeDataListener = terminalApi.onData(this.terminalId, (data) => {
      this.enqueueWrite(data)
    })

    // Seed the server's coalescing cadence with our starting visibility.
    // setVisible() only fires on a *change*, so a terminal mounted hidden
    // (TerminalManager keeps every tab mounted) would otherwise stream at full
    // rate until its first visibility toggle.
    terminalApi.setVisible(this.terminalId, this.visible)

    // Wire PTY exit -> status change
    this.removeExitListener = terminalApi.onExit(this.terminalId, (code) => {
      // Flush through the queue so the exit notice lands after any pending output.
      this.enqueueWrite(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`)
      this.flush()
      callbacks.onStatusChange('exited', code)
    })

    // Create the PTY
    callbacks.onStatusChange('creating')
    const createTerminal = opts.createTerminal ?? terminalApi.create
    createTerminal(this.terminalId, opts.cwd, opts.shell)
      .then(unwrapEnvelope)
      .then((result) => {
        if (result.success) {
          callbacks.onStatusChange('running')

          // Immediately sync PTY size with xterm.js's actual dimensions.
          // The PTY is created with default 80×24, but xterm.js was already fit
          // to the container (which may be much wider/taller). The ResizeObserver
          // initial callback likely fired BEFORE the PTY existed, so its resize
          // was silently dropped. Without this, zsh uses 80-col cursor positioning
          // while xterm.js renders at the actual width, causing visual mismatches
          // (e.g. auto-suggest redraws writing text at wrong positions).
          // Must run immediately (not debounced) so the initial size is correct.
          this.syncSizeToPty()

          terminalApi.logClientDiagnostics('xterm-terminal-created', {
            terminalId: this.terminalId,
            renderer: this.rendererKind,
            cols: this.lastSyncedCols,
            rows: this.lastSyncedRows,
            fontFamily: terminal.options.fontFamily,
            fontSize: terminal.options.fontSize
          })
        } else {
          terminal.write(`\x1b[31mFailed to create terminal: ${result.error}\x1b[0m\r\n`)
          callbacks.onStatusChange('exited')
        }
      })

    // ResizeObserver for auto-fit. Debounced (trailing) so a storm of width
    // changes — e.g. when the single session view is reparented between the
    // main tab and the ticket modal, or during a modal open/close animation —
    // collapses into one fit + one PTY resize at the final settled width.
    // Without this, each intermediate width fires a resize whose SIGWINCH redraw
    // arrives slowly over the multi-hop transport, so xterm reflows stale content
    // at a width the PTY hasn't caught up to yet (garbled rendering).
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer)
      this.resizeDebounceTimer = setTimeout(() => {
        this.resizeDebounceTimer = null
        this.syncSizeToPty()
      }, 100)
    })
    this.resizeObserver.observe(container)
  }

  /**
   * Fit xterm.js to its container and, only if the resulting dimensions differ
   * from the last value we sent, push the new size to the PTY. The
   * changed-dimensions guard avoids spurious reflows/resizes when the container
   * is reparented between two equal-width targets or the observer fires at an
   * unchanged size.
   */
  private syncSizeToPty(): void {
    try {
      if (!this.fitAddon || !this.container?.offsetWidth) return
      this.fitAddon.fit()
      const dims = this.fitAddon.proposeDimensions()
      if (!dims) return
      // Only push a new size to the PTY (and trigger its SIGWINCH redraw) when
      // the dimensions actually changed. Avoids spurious reflows when the
      // observer fires at an unchanged size (e.g. reparent between two
      // equal-width targets).
      if (dims.cols !== this.lastSyncedCols || dims.rows !== this.lastSyncedRows) {
        this.lastSyncedCols = dims.cols
        this.lastSyncedRows = dims.rows
        terminalApi.resize(this.terminalId, dims.cols, dims.rows).then(unwrapEnvelope)
      }
      // Force a clean repaint after every settled fit — even when the size is
      // unchanged. A DOM reparent (e.g. the session view being moved between the
      // main pane and the ticket modal) detaches and reattaches the WebGL
      // canvas. xterm.js only repaints dirty cells, so the GPU canvas keeps
      // showing stale/overlapping glyphs from the pre-reparent layout until
      // something dirties them. The caller debounces, so this is one repaint per
      // settled resize, not one per intermediate width.
      this.forceRepaint()
    } catch {
      // Ignore fit/resize errors during setup or teardown
    }
  }

  /**
   * Force xterm.js to repaint every visible row from the buffer, flushing any
   * stale pixels the WebGL renderer retained across a DOM reparent. Safe to call
   * at any time — no-ops if the terminal has been disposed, and
   * clearTextureAtlas() is itself a no-op when the WebGL renderer isn't active.
   */
  private forceRepaint(): void {
    const terminal = this.terminal
    if (!terminal) return
    try {
      terminal.clearTextureAtlas()
      terminal.refresh(0, terminal.rows - 1)
    } catch {
      // Renderer may be mid-teardown; ignore.
    }
  }

  setShiftEnterAsNewline(enabled: boolean): void {
    this.shiftEnterAsNewline = enabled
  }

  /**
   * Scrollback to use for a given visibility: full history while visible, a
   * small buffer while hidden. Clamped so we never raise scrollback above the
   * configured full value (e.g. a user who set scrollback-limit < 1000).
   */
  private scrollbackForVisibility(visible: boolean): number {
    return visible ? this.fullScrollback : Math.min(this.fullScrollback, HIDDEN_SCROLLBACK)
  }

  /**
   * Attach the WebGL renderer (idempotent). On failure — GPU blocklist, VM,
   * remote session, or no free WebGL context — xterm stays on its DOM renderer,
   * which renders fonts noticeably differently but works everywhere.
   */
  private loadWebgl(terminal: Terminal): void {
    if (this.webglAddon) return
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        // The browser revoked our GL context (e.g. another terminal became
        // visible and took the last slot). Drop to the DOM renderer; a later
        // setVisible can reload.
        webglAddon.dispose()
        this.webglAddon = null
        this.rendererKind = 'dom'
        console.warn('[terminal-font] WebGL context lost, falling back to DOM renderer')
        terminalApi.logClientDiagnostics('xterm-renderer-fallback', {
          terminalId: this.terminalId,
          reason: 'context-loss'
        })
      })
      terminal.loadAddon(webglAddon)
      this.webglAddon = webglAddon
      this.rendererKind = 'webgl'
    } catch (err) {
      this.webglAddon = null
      this.rendererKind = 'dom'
      console.warn('[terminal-font] WebGL addon failed, falling back to DOM renderer', err)
      terminalApi.logClientDiagnostics('xterm-renderer-fallback', {
        terminalId: this.terminalId,
        reason: 'load-failed',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** Tear down the WebGL renderer, freeing its GL context + glyph atlas. xterm
   *  reverts to its DOM renderer for this terminal. No-op if already unloaded. */
  private unloadWebgl(): void {
    if (!this.webglAddon) return
    this.webglAddon.dispose()
    this.webglAddon = null
    this.rendererKind = 'dom'
  }

  /** Buffer one PTY output chunk and ensure a flush is scheduled. */
  private enqueueWrite(data: string): void {
    if (!this.terminal) return
    this.pendingWrites.push(data)
    this.pendingBytes += data.length
    // Burst guard: never let the buffer grow without bound (e.g. rAF paused while
    // the window is backgrounded but an agent keeps streaming).
    if (this.pendingBytes >= MAX_PENDING_BYTES) {
      this.flush()
      return
    }
    this.scheduleFlush()
  }

  /**
   * Schedule a flush. Visible terminals parse once per animation frame. Hidden
   * terminals schedule NOTHING: their output stays buffered in pendingWrites and
   * is written to xterm only when they become visible (setVisible), when their
   * screen is scraped (readScreen), or when the burst guard trips (enqueueWrite).
   * Parsing every backgrounded agent's TUI on the one renderer thread — even
   * coalesced to a slow cadence — was the dominant render-lag cost under a fleet.
   */
  private scheduleFlush(): void {
    if (!this.visible) return
    if (this.flushRaf !== null) return
    this.flushRaf = requestAnimationFrame(() => {
      this.flushRaf = null
      this.flush()
    })
  }

  /** Write all buffered PTY output to xterm in a single call. */
  private flush(): void {
    if (this.flushRaf !== null) {
      cancelAnimationFrame(this.flushRaf)
      this.flushRaf = null
    }
    if (this.pendingWrites.length === 0) return
    const data = this.pendingWrites.join('')
    this.pendingWrites = []
    this.pendingBytes = 0
    this.terminal?.write(data)
  }

  write(data: string): void {
    // Flush first so injected text keeps its order relative to PTY output.
    this.flush()
    this.terminal?.write(data)
  }

  /**
   * Snapshot the currently-visible rows as decoded text (one string per row).
   * Reads only the viewport (not scrollback) so callers see exactly what the
   * user sees — used to detect and parse the plan-mode approval menu. Returns
   * an empty array when the terminal isn't mounted.
   */
  readScreen(): string[] {
    // Drain buffered-while-hidden output first so callers (e.g. plan-mode menu
    // detection) read the live screen even when this terminal is hidden.
    this.flush()
    const buffer = this.terminal?.buffer.active
    if (!this.terminal || !buffer) return []
    const lines: string[] = []
    const start = buffer.baseY
    const end = start + this.terminal.rows
    for (let i = start; i < end; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return lines
  }

  resize(cols: number, rows: number): void {
    terminalApi.resize(this.terminalId, cols, rows).then(unwrapEnvelope)
  }

  focus(): void {
    this.terminal?.focus()
  }

  clear(): void {
    this.terminal?.clear()
  }

  updateTheme(): void {
    if (this.terminal) {
      this.terminal.options.theme = buildTheme(this.ghosttyConfig)
    }
  }

  /** Re-fit after visibility change */
  fit(): void {
    this.syncSizeToPty()
  }

  /**
   * Visibility gate. Hidden terminals buffer their PTY output unparsed (written
   * to xterm only on show / readScreen / burst — see scheduleFlush), stop
   * blinking the cursor, trim their scrollback, and drop the WebGL renderer — so
   * backgrounded agent terminals burn neither the renderer thread nor the
   * per-terminal GL context + glyph atlas (the dominant fixed memory cost). On
   * becoming visible we restore WebGL + full scrollback and flush immediately so
   * the buffered output shows at once (TerminalView also re-fits/repaints right
   * after).
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    // Tell the server so it can pick its output-coalescing cadence: hidden
    // terminals' PTY output is batched instead of streamed chunk-per-message,
    // which is what keeps a fleet of backgrounded agents from flooding the
    // single WebSocket and lagging the focused terminal's input echo.
    terminalApi.setVisible(this.terminalId, visible)
    if (this.terminal) {
      this.terminal.options.cursorBlink = visible
      // Trim scrollback when hidden / restore it when shown. Lowering
      // options.scrollback makes xterm rebuild its line buffer at the smaller
      // size, freeing the dropped BufferLines — this is the lever that keeps N
      // backgrounded terminals from each pinning a full ~10k-line buffer.
      this.terminal.options.scrollback = this.scrollbackForVisibility(visible)
      // Free / restore the GL context + glyph atlas with visibility — the fixed
      // per-terminal cost the scrollback trim leaves behind. Hidden terminals
      // fall back to xterm's DOM renderer (cheap for an off-screen viewport) and
      // we stay well under the browser's live-WebGL-context cap.
      if (visible) this.loadWebgl(this.terminal)
      else this.unloadWebgl()
    }
    if (visible) this.flush()
    else if (this.flushRaf !== null) {
      // Becoming hidden: cancel the frame-scheduled parse and leave the output
      // buffered. It is written when the terminal is shown again, scraped
      // (readScreen), or the burst guard trips — we don't parse a backgrounded
      // TUI on the shared renderer thread.
      cancelAnimationFrame(this.flushRaf)
      this.flushRaf = null
    }
  }

  searchOpen(): void {
    // Search is handled at UI level; addon is accessed here
  }

  searchClose(): void {
    this.searchAddon?.clearDecorations()
  }

  searchNext(query: string): void {
    if (this.searchAddon && query) {
      this.searchAddon.findNext(query, { regex: false, caseSensitive: false })
    }
  }

  searchPrevious(query: string): void {
    if (this.searchAddon && query) {
      this.searchAddon.findPrevious(query, { regex: false, caseSensitive: false })
    }
  }

  dispose(): void {
    if (this.flushRaf !== null) {
      cancelAnimationFrame(this.flushRaf)
      this.flushRaf = null
    }
    this.pendingWrites = []
    this.pendingBytes = 0
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer)
      this.resizeDebounceTimer = null
    }
    this.resizeObserver?.disconnect()
    this.inputDisposable?.dispose()
    this.removeDataListener?.()
    this.removeExitListener?.()
    this.searchAddon = null
    this.unloadWebgl()
    this.terminal?.dispose()
    this.terminal = null
    this.fitAddon = null
    this.container = null
    this.resizeObserver = null
    this.removeDataListener = null
    this.removeExitListener = null
    this.inputDisposable = null
  }
}
