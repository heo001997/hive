import {
  WINDOW_FOCUSED_CHANNEL,
  WINDOW_FULLSCREEN_CHANGED_CHANNEL,
  type WindowFullscreenChangedPayload
} from '../../shared/app-events'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export const emitWindowFocused = (): void => {
  void publishDesktopBackendEvent(WINDOW_FOCUSED_CHANNEL, {})
}

export const emitWindowFullscreenChanged = (fullscreen: boolean): void => {
  void publishDesktopBackendEvent(WINDOW_FULLSCREEN_CHANGED_CHANNEL, {
    fullscreen
  } satisfies WindowFullscreenChangedPayload)
}
