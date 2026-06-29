import { useEffect } from 'react'
import { monitorApi } from '@/api/monitor-api'
import { useMonitorStore } from '@/stores/useMonitorStore'
import { toast } from '@/lib/toast'

/**
 * App-wide listener for monitor alerts. Mounted once so alerts surface as toasts
 * (and bump the header badge) even when the Monitor panel is closed. When the
 * panel is open, alerts show in its feed instead, so we skip the toast.
 */
export function MonitorAlertsListener(): null {
  const pushAlert = useMonitorStore((s) => s.pushAlert)

  useEffect(() => {
    const unsubscribe = monitorApi.subscribeAlerts((alert) => {
      pushAlert(alert)
      if (useMonitorStore.getState().isOpen) return
      if (alert.severity === 'critical') toast.error(alert.message)
      else toast.warning(alert.message)
    })
    return unsubscribe
  }, [pushAlert])

  return null
}
