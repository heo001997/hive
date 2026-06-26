import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, FileText, Loader2, FolderOpen } from 'lucide-react'
import Lightbox from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import Captions from 'yet-another-react-lightbox/plugins/captions'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/captions.css'
import { useGhosttySuppression } from '@/hooks'
import { fileApi } from '@/api/file-api'
import { projectApi } from '@/api/project-api'
import { classifyPreview, mimeForPath, type PreviewKind } from '@/lib/file-preview'

/** What to preview: a ready-to-render data URL, or a file on disk to load. */
export type FilePreviewSource =
  | { kind: 'image'; src: string }
  | { kind: 'path'; path: string }

interface FilePreviewProps {
  source: FilePreviewSource
  name?: string
  onClose: () => void
  /** Overlay test id; defaults to 'file-preview'. */
  testId?: string
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; previewKind: PreviewKind; dataUrl?: string; text?: string }
  | { status: 'error'; message: string }

// In-memory images are already a full data URL — render them immediately.
function initialState(source: FilePreviewSource): Loaded {
  if (source.kind === 'image') {
    return { status: 'ready', previewKind: 'image', dataUrl: source.src }
  }
  return { status: 'loading' }
}

export function FilePreview({
  source,
  name,
  onClose,
  testId = 'file-preview'
}: FilePreviewProps): React.JSX.Element {
  useGhosttySuppression('file-preview', true)
  const [state, setState] = useState<Loaded>(() => initialState(source))

  // Close on Escape. Capture phase + stopImmediatePropagation so the keypress
  // closes only this overlay and never reaches an underlying Radix Dialog.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [onClose])

  // Load disk files lazily, picking the lightest read for the detected kind.
  // Depend on the path primitive (not the `source` object) so callers passing an
  // inline `source={{ kind: 'path', path }}` don't re-trigger the load — and flash
  // the spinner — on every unrelated parent re-render.
  const loadPath = source.kind === 'path' ? source.path : null
  useEffect(() => {
    if (loadPath === null) return
    let cancelled = false
    const path = loadPath
    const previewKind = classifyPreview(name ?? path)

    if (previewKind === 'other') {
      setState({ status: 'ready', previewKind })
      return
    }

    setState({ status: 'loading' })

    const run = async (): Promise<void> => {
      if (previewKind === 'text') {
        const res = await fileApi.readFile(path)
        if (cancelled) return
        if (res.success && res.value.success) {
          setState({ status: 'ready', previewKind, text: res.value.content ?? '' })
        } else {
          setState({
            status: 'error',
            message: (res.success ? res.value.error : res.error) || 'Could not read file'
          })
        }
        return
      }

      // image / pdf / audio / video → base64 bytes → data URL
      const res = await fileApi.readImageAsBase64(path)
      if (cancelled) return
      if (res.success && res.value.data) {
        const mime = res.value.mimeType ?? mimeForPath(name ?? path)
        setState({
          status: 'ready',
          previewKind,
          dataUrl: `data:${mime};base64,${res.value.data}`
        })
      } else {
        setState({
          status: 'error',
          message: (res.success ? undefined : res.error) || 'Could not load file'
        })
      }
    }

    run().catch((err) => {
      if (!cancelled) {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load' })
      }
    })

    return () => {
      cancelled = true
    }
  }, [loadPath, name])

  const showInFolder = (): void => {
    if (source.kind === 'path') projectApi.showInFolder(source.path).catch(() => {})
  }

  // Images use yet-another-react-lightbox: wheel/pinch zoom, drag-pan and a
  // double-click zoom, with the filename as a caption. It portals itself and
  // owns Escape + backdrop-close, so route its close back to our onClose.
  if (state.status === 'ready' && state.previewKind === 'image' && state.dataUrl) {
    return (
      <Lightbox
        open
        close={onClose}
        slides={[{ src: state.dataUrl, alt: name, description: name }]}
        plugins={[Zoom, Captions]}
        carousel={{ finite: true }}
        controller={{ closeOnBackdropClick: true }}
        zoom={{ maxZoomPixelRatio: 5, scrollToZoom: true }}
        captions={{ descriptionTextAlign: 'center', showToggle: false }}
        styles={{ root: { zIndex: 9999 } }}
        render={{ buttonPrev: () => null, buttonNext: () => null }}
      />
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid={testId}
    >
      <div
        className="relative flex max-h-[90vh] max-w-[90vw] flex-col p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="absolute -right-2 -top-2 z-10 rounded-full bg-background/90 p-2 text-foreground shadow-lg transition-colors hover:bg-background"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <PreviewBody state={state} name={name} canReveal={source.kind === 'path'} onReveal={showInFolder} />

        {name && <div className="mt-2 text-center text-sm text-white/90">{name}</div>}
      </div>
    </div>,
    document.body
  )
}

function PreviewBody({
  state,
  name,
  canReveal,
  onReveal
}: {
  state: Loaded
  name?: string
  canReveal: boolean
  onReveal: () => void
}): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="flex h-40 w-40 items-center justify-center rounded-lg bg-background/90">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (state.status === 'error') {
    return <Fallback name={name} message={state.message} canReveal={canReveal} onReveal={onReveal} />
  }

  switch (state.previewKind) {
    // 'image' is handled by the yet-another-react-lightbox branch in FilePreview
    // before PreviewBody is reached, so it never lands here.
    case 'pdf':
      return (
        <iframe
          src={state.dataUrl}
          title={name ?? 'PDF preview'}
          className="h-[85vh] w-[85vw] rounded-lg border-0 bg-white shadow-2xl"
        />
      )
    case 'video':
      return (
        <video
          src={state.dataUrl}
          controls
          autoPlay
          className="max-h-[85vh] max-w-[90vw] rounded-lg shadow-2xl"
        />
      )
    case 'audio':
      return (
        <div className="rounded-lg bg-background/95 p-6 shadow-2xl">
          <audio src={state.dataUrl} controls autoPlay className="w-[60vw] max-w-[480px]" />
        </div>
      )
    case 'text':
      return <TextPreview text={state.text ?? ''} />

    default:
      return <Fallback name={name} canReveal={canReveal} onReveal={onReveal} />
  }
}

/**
 * Scrollable text/code/markdown viewer.
 *
 * Two real-app gotchas this guards against:
 *  - Scroll lock: when opened from inside a Radix Dialog, react-remove-scroll
 *    adds a document-level non-passive `wheel` listener that preventDefaults
 *    scroll for any target outside the dialog subtree. This overlay is portaled
 *    to `document.body` (a sibling of React's `#root`), so a React `onWheel`
 *    handler never fires for it — React delegates events at `#root`, which is
 *    not in the native bubble path of a body portal. A *native* listener on the
 *    element itself does fire (it's directly in the bubble path) and stops the
 *    event before it reaches document, so the inner scroll works.
 *  - Size cap via inline styles, not Tailwind classes, so the <pre> is always
 *    bounded (and thus scrolls) regardless of whether an arbitrary utility like
 *    `max-w-[85vw]` made it into the generated stylesheet. min-h-0/min-w-0
 *    defeat the flex-item default min-size (`auto` = content size) that would
 *    otherwise override the max-size and let the <pre> grow past the viewport.
 */
function TextPreview({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: WheelEvent): void => e.stopPropagation()
    el.addEventListener('wheel', stop, { passive: true })
    return () => el.removeEventListener('wheel', stop)
  }, [])
  return (
    <pre
      ref={ref}
      style={{ maxHeight: '85vh', maxWidth: '85vw', minHeight: 0, minWidth: 0 }}
      className="min-h-0 min-w-0 overflow-auto rounded-lg bg-background/95 p-4 text-left font-mono text-xs leading-relaxed text-foreground shadow-2xl"
    >
      {text}
    </pre>
  )
}

function Fallback({
  name,
  message,
  canReveal,
  onReveal
}: {
  name?: string
  message?: string
  canReveal: boolean
  onReveal: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex w-72 flex-col items-center gap-3 rounded-lg bg-background/95 p-6 text-center shadow-2xl"
      data-testid="file-preview-fallback"
    >
      <FileText className="h-10 w-10 text-muted-foreground" />
      <div className="text-sm font-medium text-foreground break-all">{name ?? 'File'}</div>
      <p className="text-xs text-muted-foreground">
        {message ?? "This file type can't be previewed in the app."}
      </p>
      {canReveal && (
        <button
          type="button"
          onClick={onReveal}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent/50"
          data-testid="file-preview-reveal"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Show in folder
        </button>
      )}
    </div>
  )
}
