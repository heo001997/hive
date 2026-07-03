import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { setRendererRpcClient } from '@/api/rpc-client'
import { DEFAULT_STRICT_VERIFY_PROMPT } from '@shared/types/completion'

function installSettingsRpcMock(settingsValue: string | null = null): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (method: string) => {
    switch (method) {
      case 'db.setting.get':
        return settingsValue
      case 'db.setting.set':
        return true
      case 'settingsOps.loadCustomCommandsFile':
        return { success: true, commands: [], mtime: null }
      case 'settingsOps.saveCustomCommandsFile':
        return { success: true, mtime: 123 }
      case 'telegramOps.getConfig':
        return null
      default:
        return undefined
    }
  })
  setRendererRpcClient({ request, subscribe: vi.fn(() => () => {}) })
  return request
}

describe('Settings Store — Strict Verify Ticket Review State', () => {
  beforeEach(() => {
    installSettingsRpcMock()
    vi.restoreAllMocks()
  })

  it('defaults: ENABLED, 8s delay, 5s frozen window, claude-code, no model, 6000 chars, 0.6 threshold', () => {
    const s = useSettingsStore.getState()
    // WS4 — frozen-first verification ships on out of the box (was false).
    expect(s.kanbanStrictVerifyEnabled).toBe(true)
    expect(s.kanbanStrictVerifyDelaySeconds).toBe(8)
    expect(s.kanbanStrictVerifyFrozenIdleSeconds).toBe(5)
    expect(s.kanbanStrictVerifyProvider).toBe('claude-code')
    expect(s.kanbanStrictVerifyModel).toBe('')
    expect(s.kanbanStrictVerifyChars).toBe(6000)
    expect(s.kanbanStrictVerifyConfidenceThreshold).toBe(0.6)
  })

  it('defaults: both sub-gates on, prompt seeded from the built-in default', () => {
    const s = useSettingsStore.getState()
    expect(s.kanbanStrictVerifySnapshotEnabled).toBe(true)
    expect(s.kanbanStrictVerifyReviewerEnabled).toBe(true)
    expect(s.kanbanStrictVerifyPrompt).toBe(DEFAULT_STRICT_VERIFY_PROMPT)
  })

  it('defaults: In Progress rescue is on', () => {
    expect(useSettingsStore.getState().kanbanInProgressRescueEnabled).toBe(true)
  })

  it('persists the In Progress rescue toggle to the database', async () => {
    const request = installSettingsRpcMock()
    await useSettingsStore.getState().updateSetting('kanbanInProgressRescueEnabled', false)

    expect(useSettingsStore.getState().kanbanInProgressRescueEnabled).toBe(false)
    expect(request).toHaveBeenCalledWith(
      'db.setting.set',
      expect.objectContaining({
        value: expect.stringContaining('"kanbanInProgressRescueEnabled":false')
      })
    )
  })

  it('persists the snapshot/reviewer toggles and an edited prompt', async () => {
    const request = installSettingsRpcMock()
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifySnapshotEnabled', false)
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifyReviewerEnabled', false)
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifyPrompt', 'my custom prompt')

    const s = useSettingsStore.getState()
    expect(s.kanbanStrictVerifySnapshotEnabled).toBe(false)
    expect(s.kanbanStrictVerifyReviewerEnabled).toBe(false)
    expect(s.kanbanStrictVerifyPrompt).toBe('my custom prompt')
    expect(request).toHaveBeenCalledWith(
      'db.setting.set',
      expect.objectContaining({
        value: expect.stringContaining('"kanbanStrictVerifySnapshotEnabled":false')
      })
    )
    expect(request).toHaveBeenCalledWith(
      'db.setting.set',
      expect.objectContaining({
        value: expect.stringContaining('"kanbanStrictVerifyPrompt":"my custom prompt"')
      })
    )
  })

  it('persists the provider choice to the database', async () => {
    const request = installSettingsRpcMock()
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifyProvider', 'codex')

    expect(useSettingsStore.getState().kanbanStrictVerifyProvider).toBe('codex')
    expect(request).toHaveBeenCalledWith(
      'db.setting.set',
      expect.objectContaining({
        key: 'app_settings',
        value: expect.stringContaining('"kanbanStrictVerifyProvider":"codex"')
      })
    )
  })

  it('persists the enable toggle, delay, model, and numeric tuning fields', async () => {
    const request = installSettingsRpcMock()
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifyEnabled', true)
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifyDelaySeconds', 5)
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifyModel', 'gpt-5-mini')
    await useSettingsStore.getState().updateSetting('kanbanStrictVerifyConfidenceThreshold', 0.8)

    const s = useSettingsStore.getState()
    expect(s.kanbanStrictVerifyEnabled).toBe(true)
    expect(s.kanbanStrictVerifyDelaySeconds).toBe(5)
    expect(s.kanbanStrictVerifyModel).toBe('gpt-5-mini')
    expect(s.kanbanStrictVerifyConfidenceThreshold).toBe(0.8)
    expect(request).toHaveBeenCalledWith(
      'db.setting.set',
      expect.objectContaining({
        value: expect.stringContaining('"kanbanStrictVerifyConfidenceThreshold":0.8')
      })
    )
  })

  it('loads strict-verify settings from the database', async () => {
    installSettingsRpcMock(
      JSON.stringify({
        kanbanStrictVerifyEnabled: true,
        kanbanStrictVerifyDelaySeconds: 12,
        kanbanStrictVerifyProvider: 'opencode',
        kanbanStrictVerifyModel: 'claude-haiku-4-5-20251001',
        kanbanStrictVerifyChars: 12000,
        kanbanStrictVerifyConfidenceThreshold: 0.75,
        kanbanStrictVerifySnapshotEnabled: false,
        kanbanStrictVerifyReviewerEnabled: false,
        kanbanStrictVerifyPrompt: 'loaded prompt'
      })
    )
    await useSettingsStore.getState().loadFromDatabase()

    const s = useSettingsStore.getState()
    expect(s.kanbanStrictVerifyEnabled).toBe(true)
    expect(s.kanbanStrictVerifyDelaySeconds).toBe(12)
    expect(s.kanbanStrictVerifyProvider).toBe('opencode')
    expect(s.kanbanStrictVerifyModel).toBe('claude-haiku-4-5-20251001')
    expect(s.kanbanStrictVerifyChars).toBe(12000)
    expect(s.kanbanStrictVerifyConfidenceThreshold).toBe(0.75)
    expect(s.kanbanStrictVerifySnapshotEnabled).toBe(false)
    expect(s.kanbanStrictVerifyReviewerEnabled).toBe(false)
    expect(s.kanbanStrictVerifyPrompt).toBe('loaded prompt')
  })
})
