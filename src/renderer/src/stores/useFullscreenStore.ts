import { create } from 'zustand'
import { systemApi } from '@/api/system-api'

const FULLSCREEN_MEDIA_QUERY = '(display-mode: fullscreen)'

// Synchronous best-guess for the first paint (covers a renderer reload while the
// window is already fullscreen). The main process is the source of truth and
// corrects this via `onWindowFullscreenChanged` as soon as state changes.
const initialGuess = (): boolean => {
  try {
    return window.matchMedia(FULLSCREEN_MEDIA_QUERY).matches
  } catch {
    return false
  }
}

interface FullscreenState {
  isFullscreen: boolean
  setFullscreen: (value: boolean) => void
  /** Wire up the main-process + media-query listeners. Returns a cleanup fn. */
  initialize: () => () => void
}

export const useFullscreenStore = create<FullscreenState>((set) => ({
  isFullscreen: initialGuess(),
  setFullscreen: (value) => set({ isFullscreen: value }),
  initialize: () => {
    const unsubscribeMain = systemApi.onWindowFullscreenChanged((fullscreen) => {
      set({ isFullscreen: fullscreen })
    })

    // Secondary signal in case the backend event is missed (e.g. before the WS
    // subscription is established). Harmless to keep both — last write wins.
    let media: MediaQueryList | null = null
    const onMediaChange = (e: MediaQueryListEvent): void => set({ isFullscreen: e.matches })
    try {
      media = window.matchMedia(FULLSCREEN_MEDIA_QUERY)
      media.addEventListener('change', onMediaChange)
      set({ isFullscreen: media.matches })
    } catch {
      // matchMedia unavailable — rely on the main-process event only.
    }

    return () => {
      unsubscribeMain()
      media?.removeEventListener('change', onMediaChange)
    }
  }
}))
