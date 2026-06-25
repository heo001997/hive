import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ImageLightbox } from './ImageLightbox'

describe('ImageLightbox', () => {
  it('renders the image with the given src and name caption', () => {
    render(<ImageLightbox src="data:image/png;base64,abc" name="diagram.png" onClose={() => {}} />)

    const img = screen.getByRole('img', { name: 'diagram.png' })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,abc')
    expect(screen.getByText('diagram.png')).toBeInTheDocument()
  })

  it('portals the overlay directly under document.body (escapes transformed ancestors)', () => {
    const { container } = render(
      <ImageLightbox src="data:image/png;base64,abc" name="pic" onClose={() => {}} />
    )

    const overlay = screen.getByTestId('image-lightbox')
    // Rendered via portal => not inside the component's own container subtree...
    expect(container).not.toContainElement(overlay)
    // ...but a direct child of document.body, so `fixed inset-0` covers the viewport.
    expect(overlay.parentElement).toBe(document.body)
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<ImageLightbox src="data:image/png;base64,abc" onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the overlay (outside the image) is clicked', () => {
    const onClose = vi.fn()
    render(<ImageLightbox src="data:image/png;base64,abc" onClose={onClose} />)

    fireEvent.click(screen.getByTestId('image-lightbox'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when the image itself is clicked', () => {
    const onClose = vi.fn()
    render(<ImageLightbox src="data:image/png;base64,abc" name="pic" onClose={onClose} />)

    fireEvent.click(screen.getByRole('img', { name: 'pic' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<ImageLightbox src="data:image/png;base64,abc" onClose={onClose} />)

    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
