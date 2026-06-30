import type { LocalEnvironmentBootstrap } from '@shared/desktop-bridge'

export type { LocalEnvironmentBootstrap } from '@shared/desktop-bridge'

export interface DesktopBridge {
  readonly getLocalEnvironmentBootstrap: () => Promise<LocalEnvironmentBootstrap | null>
  readonly getPathForFile?: (file: File) => string
  readonly relaunchApp?: () => Promise<void>
}

export const getDesktopBridge = (): DesktopBridge | null =>
  typeof window === 'undefined' ? null : (window.desktopBridge ?? null)
