import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ImageLightbox } from './ImageLightbox'

// ImageLightbox is a thin wrapper over FilePreview, which renders in-memory
// images through yet-another-react-lightbox (zoom/pan + filename caption).
describe('ImageLightbox', () => {
  it('renders the image with the given src and name caption', () => {
    render(<ImageLightbox src="data:image/png;base64,abc" name="diagram.png" onClose={() => {}} />)

    const img = screen.getByRole('img', { name: 'diagram.png' })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,abc')
    expect(screen.getByText('diagram.png')).toBeInTheDocument()
  })

  it('portals the lightbox directly under document.body (escapes transformed ancestors)', () => {
    const { container } = render(
      <ImageLightbox src="data:image/png;base64,abc" name="pic" onClose={() => {}} />
    )

    // Rendered via the lightbox's own portal => not inside our container subtree...
    expect(container.querySelector('img')).toBeNull()
    // ...but under document.body, so the full-screen overlay covers the viewport.
    const portal = screen.getByRole('img', { name: 'pic' }).closest('.yarl__portal')
    expect(portal?.parentElement).toBe(document.body)
  })

  // Escape/backdrop close are handled inside yet-another-react-lightbox via a
  // synthetic key handler on its body-portaled container, which fireEvent can't
  // reach under jsdom — so we assert the close control is wired/present rather
  // than DOM-dispatching a key event that the library never receives in tests.
  it('exposes zoom and close controls', () => {
    render(<ImageLightbox src="data:image/png;base64,abc" name="pic" onClose={() => {}} />)

    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument()
    expect(screen.getByLabelText('Zoom out')).toBeInTheDocument()
    expect(screen.getByLabelText('Close')).toBeInTheDocument()
  })
})
