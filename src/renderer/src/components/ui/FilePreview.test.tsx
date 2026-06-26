import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreview } from './FilePreview'
import { fileApi } from '@/api/file-api'
import { projectApi } from '@/api/project-api'

vi.mock('@/api/file-api', () => ({
  fileApi: { readFile: vi.fn(), readImageAsBase64: vi.fn() }
}))
vi.mock('@/api/project-api', () => ({
  projectApi: { showInFolder: vi.fn() }
}))

const readFile = vi.mocked(fileApi.readFile)
const readImageAsBase64 = vi.mocked(fileApi.readImageAsBase64)
const showInFolder = vi.mocked(projectApi.showInFolder)

beforeEach(() => {
  vi.clearAllMocks()
  // Real projectApi.showInFolder is async (returns Promise<void>); the component
  // chains .catch on it, so the mock must resolve too.
  showInFolder.mockResolvedValue(undefined)
})

describe('FilePreview — in-memory image', () => {
  it('renders the image in a zoomable lightbox portaled under document.body', () => {
    const { container } = render(
      <FilePreview source={{ kind: 'image', src: 'data:image/png;base64,abc' }} name="d.png" onClose={() => {}} />
    )
    // yet-another-react-lightbox renders into its own portal, not our subtree.
    expect(container.querySelector('img')).toBeNull()
    const img = screen.getByRole('img', { name: 'd.png' })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,abc')
    expect(img.closest('.yarl__portal')?.parentElement).toBe(document.body)
    // Zoom controls + filename caption are what make this nicer than a bare <img>.
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument()
    expect(screen.getByText('d.png')).toBeInTheDocument()
  })

  // The lightbox owns Escape/backdrop close internally; its synthetic key handler
  // lives on a body-portaled container that fireEvent can't reach under jsdom, so
  // that close path is verified at the integration level. Here we just assert the
  // close affordance is present (the lightbox's own control).
  it('exposes a close affordance', () => {
    render(<FilePreview source={{ kind: 'image', src: 'data:image/png;base64,abc' }} name="p" onClose={() => {}} />)
    expect(screen.getByLabelText('Close')).toBeInTheDocument()
  })
})

describe('FilePreview — disk files', () => {
  it('renders non-markdown text in a <pre> inside a scrollable container', async () => {
    readFile.mockResolvedValue({ success: true, value: { success: true, content: 'hello from disk' } })
    render(<FilePreview source={{ kind: 'path', path: '/tmp/app.log' }} name="app.log" onClose={() => {}} />)

    const pre = (await screen.findByText('hello from disk')).closest('pre')
    expect(pre).toBeInTheDocument()
    // The wrapper, not the <pre>, is the scroll container — and it lives inside the
    // Radix dialog, so its overflow scroll is permitted by the scroll-lock.
    expect(pre?.closest('.overflow-auto')).not.toBeNull()
    expect(readFile).toHaveBeenCalledWith('/tmp/app.log')
    expect(readImageAsBase64).not.toHaveBeenCalled()
  })

  it('closes the dialog preview via Escape and the Close button', async () => {
    readFile.mockResolvedValue({ success: true, value: { success: true, content: 'body' } })
    const onClose = vi.fn()
    render(<FilePreview source={{ kind: 'path', path: '/tmp/app.log' }} name="app.log" onClose={onClose} />)
    await screen.findByText('body')

    // Radix owns Escape via a real document keydown listener — our onOpenChange
    // wiring routes it back to onClose.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders markdown files as formatted markdown, not raw text', async () => {
    readFile.mockResolvedValue({ success: true, value: { success: true, content: '# Heading One' } })
    render(<FilePreview source={{ kind: 'path', path: '/tmp/notes.md' }} name="notes.md" onClose={() => {}} />)

    const heading = await screen.findByText('Heading One')
    expect(heading.tagName).toBe('H1')
    expect(heading.closest('pre')).toBeNull()
    // Still inside the scrollable, dialog-hosted body.
    expect(heading.closest('.overflow-auto')).not.toBeNull()
  })

  it('loads images as a base64 data URL', async () => {
    readImageAsBase64.mockResolvedValue({ success: true, value: { data: 'QUJD', mimeType: 'image/png' } })
    render(<FilePreview source={{ kind: 'path', path: '/tmp/a.png' }} name="a.png" onClose={() => {}} />)

    const img = await screen.findByRole('img', { name: 'a.png' })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,QUJD')
  })

  it('renders a PDF in an iframe', async () => {
    readImageAsBase64.mockResolvedValue({ success: true, value: { data: 'JVBE' } })
    render(<FilePreview source={{ kind: 'path', path: '/tmp/spec.pdf' }} name="spec.pdf" onClose={() => {}} />)

    const frame = await screen.findByTitle('spec.pdf')
    expect(frame).toHaveAttribute('src', 'data:application/pdf;base64,JVBE')
  })

  it('shows a fallback card with Show-in-folder for unpreviewable files', async () => {
    render(<FilePreview source={{ kind: 'path', path: '/tmp/archive.zip' }} name="archive.zip" onClose={() => {}} />)

    expect(await screen.findByTestId('file-preview-fallback')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('file-preview-reveal'))
    expect(showInFolder).toHaveBeenCalledWith('/tmp/archive.zip')
    expect(readFile).not.toHaveBeenCalled()
    expect(readImageAsBase64).not.toHaveBeenCalled()
  })

  it('shows an error fallback when the read fails', async () => {
    readImageAsBase64.mockResolvedValue({ success: false, errorCode: 'E', error: 'File too large (max 20MB)' })
    render(<FilePreview source={{ kind: 'path', path: '/tmp/big.png' }} name="big.png" onClose={() => {}} />)

    expect(await screen.findByText('File too large (max 20MB)')).toBeInTheDocument()
  })
})
