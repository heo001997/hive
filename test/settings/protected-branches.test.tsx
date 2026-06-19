import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mockUpdateSetting = vi.fn()
let mockSettingsState: Record<string, unknown> = {}

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      return selector ? selector(mockSettingsState) : mockSettingsState
    },
    {
      getState: () => mockSettingsState
    }
  )
}))

vi.mock('@/stores/useThemeStore', () => ({
  useThemeStore: () => ({ setTheme: vi.fn() })
}))

vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: () => ({ resetToDefaults: vi.fn() })
}))

vi.mock('@/lib/themes', () => ({
  DEFAULT_THEME_ID: 'default'
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('SettingsGeneral protected branches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsState = {
      autoStartSession: true,
      autoPullBeforeWorktree: true,
      boardMode: 'sticky-tab',
      followUpTriggerColumn: 'done',
      vimModeEnabled: false,
      keepAwakeEnabled: false,
      mergeConflictMode: 'always-ask',
      protectedBranches: '',
      tipsEnabled: true,
      warnBeforeQuitting: true,
      breedType: 'dogs',
      showModelIcons: false,
      showModelProvider: false,
      usageIndicatorMode: 'current-agent',
      usageIndicatorProviders: [],
      defaultAgentSdk: 'opencode',
      availableAgentSdks: null,
      stripAtMentions: true,
      updateSetting: mockUpdateSetting,
      resetToDefaults: vi.fn()
    }
  })

  it('persists the protected branches input on blur', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const input = screen.getByTestId('protected-branches-input')
    expect(screen.getByText('Protected branches')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'main,master' } })
    fireEvent.blur(input)

    expect(mockUpdateSetting).toHaveBeenCalledWith('protectedBranches', 'main,master')
  })
})
