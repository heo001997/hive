import { useEffect, useRef, useState } from 'react'
import { isHiveTelemetryEnabled, refreshHiveEnterpriseOrg } from '@/api/hive-enterprise/client'
import { AppLayout } from '@/components/layout'
import { ErrorBoundary } from '@/components/error'
import { TooltipProvider } from '@/components/ui/tooltip'
import { initPlatform } from '@/lib/platform'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTipStore } from '@/stores/useTipStore'
import { useFullscreenStore } from '@/stores/useFullscreenStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { PetStatusBridge } from '@/components/pet/PetStatusBridge'

function App(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const didRefreshHiveOrg = useRef(false)
  const hiveAuthToken = useSettingsStore((state) => state.hiveAuthToken)
  const hiveOrganizationId = useSettingsStore((state) => state.hiveOrganizationId)
  const settingsLoading = useSettingsStore((state) => state.isLoading)

  useEffect(() => {
    initPlatform().then(() => {
      // Load seen tips from DB so the tip system knows which tips to skip
      useTipStore.getState().loadSeenTips()
      setReady(true)
    })
  }, [])

  // Track window fullscreen state so the header can drop the macOS traffic-light
  // spacer (window buttons are hidden in fullscreen).
  useEffect(() => useFullscreenStore.getState().initialize(), [])

  // App-lifetime auto-launch owner. This — NOT the on-screen board — turns
  // KANBAN_TICKETS_CREATED (out-of-band condition-gate fix rounds via the CLI) and the
  // cold-start backlog replay into launches, so a fresh round on a board that isn't
  // displayed still starts. App is the always-mounted, unfiltered root, mirroring the
  // fullscreen init above; keep this the sole caller.
  useEffect(() => useKanbanStore.getState().initializeAutoLaunch(), [])

  useEffect(() => {
    if (settingsLoading || didRefreshHiveOrg.current) return
    if (!isHiveTelemetryEnabled({ hiveAuthToken, hiveOrganizationId })) return
    didRefreshHiveOrg.current = true
    void refreshHiveEnterpriseOrg()
  }, [hiveAuthToken, hiveOrganizationId, settingsLoading])

  if (!ready) return <div />

  return (
    <ErrorBoundary componentName="App">
      <TooltipProvider delayDuration={350}>
        <PetStatusBridge />
        <AppLayout />
      </TooltipProvider>
    </ErrorBoundary>
  )
}

export default App
