export const WINDOW_FOCUSED_CHANNEL = 'app:windowFocused'
export const WINDOW_FULLSCREEN_CHANGED_CHANNEL = 'app:windowFullscreenChanged'

export interface WindowFullscreenChangedPayload {
  readonly fullscreen: boolean
}
