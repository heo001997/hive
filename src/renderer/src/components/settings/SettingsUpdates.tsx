import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RefreshCw } from 'lucide-react'
import { updaterApi } from '@/api/updater-api'

export function SettingsUpdates(): React.JSX.Element {
  const { autoUpdateEnabled, updateChannel, updateSetting } = useSettingsStore()
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    updaterApi
      .getVersion()
      .then(setVersion)
      .catch(() => {})
  }, [])

  const handleCheckForUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      await updaterApi.checkForUpdate({ manual: true })
    } catch {
      /* ignored */
    }
    setTimeout(() => setChecking(false), 2000)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Updates</h3>
        <p className="text-sm text-muted-foreground">Manage how Hive updates itself</p>
      </div>

      {/* Version display */}
      {version && (
        <div className="text-sm text-muted-foreground">
          Current version: <span className="font-mono text-foreground">{version}</span>
        </div>
      )}

      {/* Automatic update checks */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <label className="text-sm font-medium">Automatically check for updates</label>
          <p className="text-xs text-muted-foreground">
            When off, Hive won&apos;t check for or download updates in the background. You can still
            check manually below.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={autoUpdateEnabled}
          onClick={() => updateSetting('autoUpdateEnabled', !autoUpdateEnabled)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            autoUpdateEnabled ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="auto-update-enabled-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              autoUpdateEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Channel selector */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Update Channel</label>
        <p className="text-xs text-muted-foreground">
          Choose which release channel to receive updates from
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('updateChannel', 'stable')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              updateChannel === 'stable'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="update-channel-stable"
          >
            Stable
          </button>
          <button
            onClick={() => updateSetting('updateChannel', 'canary')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              updateChannel === 'canary'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="update-channel-canary"
          >
            Canary
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {updateChannel === 'canary'
            ? 'You will receive early builds with the latest features. These may contain bugs.'
            : 'You will receive stable, tested releases.'}
        </p>
      </div>

      {/* Check for updates */}
      <div className="pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckForUpdates}
          disabled={checking}
          data-testid="check-for-updates"
        >
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', checking && 'animate-spin')} />
          {checking ? 'Checking...' : 'Check for Updates'}
        </Button>
      </div>
    </div>
  )
}
