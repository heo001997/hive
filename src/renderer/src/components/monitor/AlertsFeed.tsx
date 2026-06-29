import { AlertTriangle, Info, Flame } from 'lucide-react'
import type { MonitorAlert, MonitorAlertSeverity } from '@shared/system-monitor-events'
import { cn } from '@/lib/utils'

interface AlertsFeedProps {
  alerts: MonitorAlert[]
}

const SEVERITY_META: Record<
  MonitorAlertSeverity,
  { icon: typeof Info; className: string }
> = {
  info: { icon: Info, className: 'text-sky-500' },
  warning: { icon: AlertTriangle, className: 'text-amber-500' },
  critical: { icon: Flame, className: 'text-red-500' }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function AlertsFeed({ alerts }: AlertsFeedProps): React.JSX.Element {
  if (alerts.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
        No alerts. Everything looks healthy.
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border divide-y divide-border/50 max-h-[200px] overflow-y-auto">
      {alerts.map((alert) => {
        const meta = SEVERITY_META[alert.severity]
        const Icon = meta.icon
        return (
          <div key={alert.id} className="flex items-start gap-2 px-3 py-2 text-sm">
            <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', meta.className)} />
            <div className="min-w-0 flex-1">
              <p className="truncate" title={alert.message}>
                {alert.message}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {formatTime(alert.ts)} · {alert.kind}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
