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
  it('renders a ready data-URL image immediately and portals under document.body', () => {
    const { container } = render(
      <FilePreview source={{ kind: 'image', src: 'data:image/png;base64,abc' }} name="d.png" onClose={() => {}} />
    )
    const overlay = screen.getByTestId('file-preview')
    expect(container).not.toContainElement(overlay)
    expect(overlay.parentElement).toBe(document.body)
    expect(screen.getByRole('img', { name: 'd.png' })).toHaveAttribute('src', 'data:image/png;base64,abc')
  })

  it('closes on Escape, overlay click and close button; not on image click', () => {
    const onClose = vi.fn()
    render(<FilePreview source={{ kind: 'image', src: 'data:image/png;base64,abc' }} name="p" onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('file-preview'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByRole('img', { name: 'p' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('FilePreview — disk files', () => {
  it('loads and renders text files in a <pre>', async () => {
    readFile.mockResolvedValue({ success: true, value: { success: true, content: 'hello from disk' } })
    render(<FilePreview source={{ kind: 'path', path: '/tmp/notes.md' }} name="notes.md" onClose={() => {}} />)

    expect(await screen.findByText('hello from disk')).toBeInTheDocument()
    expect(readFile).toHaveBeenCalledWith('/tmp/notes.md')
    expect(readImageAsBase64).not.toHaveBeenCalled()
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
