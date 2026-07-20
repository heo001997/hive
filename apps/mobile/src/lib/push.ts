// Push notifications via expo-notifications.
//
// Model:
//   - FOREGROUND: the app is connected over the live WebSocket, so session
//     deltas arrive on `opencode:stream` in real time. We still show incoming
//     notifications (handler below) but the UI is already live.
//   - BACKGROUND / killed: the WS is gone, so the backend delivers a push via
//     Expo's push service. Tapping it deep-links straight into the session.
//
// The Expo push token is obtained here and handed to the backend via the
// `push.register` RPC (implemented by the backend agent). The backend maps
// (owner -> token) and later sends `{ hiveSessionId }` in the notification data
// payload so a tap can route to the right SessionDetail screen.

import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import type { HiveClient } from '@hive/client'

import { registerPush, type PushRegisterParams } from './api'

// Show alerts even when the app is foregrounded (the WS keeps the UI live, but
// a heads-up is still useful for a session the user isn't currently viewing).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
})

/**
 * Request permission and return the Expo push token, or null if the user
 * declined or this is a non-device environment (e.g. a simulator, which cannot
 * receive remote push). Never throws for the "declined" case.
 */
export async function getExpoPushToken(): Promise<string | null> {
  const settings = await Notifications.getPermissionsAsync()
  let status = settings.status
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync()
    status = req.status
  }
  if (status !== 'granted') return null

  // Android needs a channel before tokens/notifications behave.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT
    })
  }

  // projectId is required for a token off Expo's push service; it comes from
  // app.json -> extra.eas.projectId (see README to set your own).
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants.easConfig as { projectId?: string } | undefined)?.projectId

  try {
    const { data } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    )
    return data
  } catch {
    // No EAS projectId / not a real device / offline — push simply stays off.
    return null
  }
}

/**
 * Obtain the push token and register it with the backend. Safe to call after
 * every successful sign-in; a no-op (returns null) when push is unavailable.
 */
export async function registerForPush(client: HiveClient): Promise<string | null> {
  const token = await getExpoPushToken()
  if (!token) return null
  // The backend schema is strict and platform ∈ ios | android | web. On a
  // managed Expo app Platform.OS is one of those; anything else (never expected
  // here) falls back to 'web' rather than being rejected.
  const platform: PushRegisterParams['platform'] =
    Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web'
  try {
    await registerPush(client, { token, platform })
  } catch {
    // Backend may not implement push.register yet — degrade gracefully; the app
    // still works foreground-live over the WS.
  }
  return token
}

/** Pull a hive session id out of a notification's data payload, if present. */
export function sessionIdFromNotification(
  notification: Notifications.Notification
): string | null {
  const data = notification.request.content.data as
    | { hiveSessionId?: unknown }
    | undefined
  const id = data?.hiveSessionId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Wire notification taps to a deep-link handler. Covers both a tap while the
 * app is running (`addNotificationResponseReceivedListener`) and a COLD START
 * from a tap (`getLastNotificationResponseAsync`). Returns a cleanup fn.
 */
export function attachNotificationTapHandler(
  onOpenSession: (hiveSessionId: string) => void
): () => void {
  // Cold start: the app was launched by tapping a notification.
  Notifications.getLastNotificationResponseAsync().then((response) => {
    if (!response) return
    const id = sessionIdFromNotification(response.notification)
    if (id) onOpenSession(id)
  })

  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const id = sessionIdFromNotification(response.notification)
    if (id) onOpenSession(id)
  })

  return () => sub.remove()
}
