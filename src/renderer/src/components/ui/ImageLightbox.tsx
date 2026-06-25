import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useGhosttySuppression } from '@/hooks'

interface ImageLightboxProps {
  src: string
  name?: string
  onClose: () => void
}

export function ImageLightbox({ src, name, onClose }: ImageLightboxProps): React.JSX.Element {
  useGhosttySuppression('image-lightbox', true)

  // Handle Escape key to close lightbox
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      data-testid="image-lightbox"
    >
      <div className="relative max-w-[90vw] max-h-[90vh] p-4">
        <button
          className="absolute -top-2 -right-2 p-2 rounded-full bg-background/90 hover:bg-background text-foreground shadow-lg transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
        <img
          src={src}
          alt={name}
          className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
        {name && <div className="mt-2 text-center text-sm text-white/90">{name}</div>}
      </div>
    </div>
  )
}
