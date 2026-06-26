import { FilePreview } from './FilePreview'

interface ImageLightboxProps {
  src: string
  name?: string
  onClose: () => void
}

/**
 * Thin wrapper over {@link FilePreview} for in-memory images (a ready data URL),
 * e.g. pasted composer images and sent chat-bubble images. Disk-backed
 * attachments should use FilePreview directly with a `path` source so it can
 * also render PDFs, text and media.
 */
export function ImageLightbox({ src, name, onClose }: ImageLightboxProps): React.JSX.Element {
  return (
    <FilePreview
      source={{ kind: 'image', src }}
      name={name}
      onClose={onClose}
      testId="image-lightbox"
    />
  )
}
