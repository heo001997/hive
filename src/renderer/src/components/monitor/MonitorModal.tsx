import { useEffect, useRef, useState } from 'react'
import { Cpu, MemoryStick, Gauge, Activity, Trash2, Pause, Play, FileText } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { monitorApi } from '@/api/monitor-api'
import { systemApi } from '@/api/system-api'
import { projectApi } from '@/api/project-api'
import { toast } from '@/lib/toast'
import { useMonitorStore } from '@/stores/useMonitorStore'
import { Sparkline } from './Sparkline'
import { ProcessTable } from './ProcessTable'
import { AlertsFeed } from './AlertsFeed'
import { formatBytes, formatPct } from './format'

function Tile({
  icon: Icon,
  label,
  value,
  sub,
  series,
  max,
  strokeClassName
}: {
  icon: typeof Cpu
  label: string
  value: string
  sub?: string
  series: number[]
  max?: number
  strokeClassName?: string
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border p-3 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      <Sparkline
        values={series}
        max={max}
        width={180}
        height={26}
        className="mt-1 w-full"
        strokeClassName={strokeClassName}
      />
    </div>
  )
}

export function MonitorModal(): React.JSX.Element | null {
  const isOpen = useMonitorStore((s) => s.isOpen)
  const close = useMonitorStore((s) => s.close)
  const snapshot = useMonitorStore((s) => s.snapshot)
  const history = useMonitorStore((s) => s.history)
  const alerts = useMonitorStore((s) => s.alerts)
  const setHistory = useMonitorStore((s) => s.setHistory)
  const setAlerts = useMonitorStore((s) => s.setAlerts)
  const applySnapshot = useMonitorStore((s) => s.applySnapshot)

  const [paused, setPaused] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  // Read inside the subscription callback without re-subscribing on each toggle.
  const pausedRef = useRef(false)
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  // On open: hydrate from server history/alerts, then stream live snapshots.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    monitorApi
      .getHistory()
      .then((h) => {
        if (!cancelled) setHistory(h)
      })
      .catch(() => undefined)
    monitorApi
      .getAlerts()
      .then((a) => {
        if (!cancelled) setAlerts(a)
      })
      .catch(() => undefined)
    // Drop snapshots while paused so the view actually freezes — toggling server
    // cadence alone doesn't, since background sampling keeps overwriting it.
    const unsubscribe = monitorApi.subscribeSnapshots((s) => {
      if (!pausedRef.current) applySnapshot(s)
    })
    return () => {
      cancelled = true
      unsubscribe()
      // Always drop the server back out of fast cadence on teardown — covers an
      // unmount that bypasses the store's close() (e.g. an error-boundary swap).
      void monitorApi.setActive(false).catch(() => undefined)
    }
  }, [isOpen, setHistory, setAlerts, applySnapshot])

  // Reset pause state whenever the panel closes.
  useEffect(() => {
    if (!isOpen) setPaused(false)
  }, [isOpen])

  if (!isOpen) return null

  const togglePause = (): void => {
    const next = !paused
    setPaused(next)
    void monitorApi.setActive(!next).catch(() => undefined)
  }

  const handleCleanup = async (): Promise<void> => {
    setCleaning(true)
    try {
      const killed = await monitorApi.cleanupOrphans()
      toast.success(killed > 0 ? `Reaped ${killed} orphaned process(es)` : 'No orphans found')
    } catch {
      toast.error('Failed to clean up orphans')
    } finally {
      setCleaning(false)
    }
  }

  const handleOpenLog = async (): Promise<void> => {
    try {
      const dir = await systemApi.getLogDir()
      await projectApi.showInFolder(dir)
    } catch {
      toast.error('Failed to open log folder')
    }
  }

  const handleKill = (pid: number, group: boolean): void => {
    void monitorApi
      .killProcess(pid, group)
      .then(() => toast.success(`Sent kill signal to pid ${pid}`))
      .catch(() => toast.error(`Failed to kill pid ${pid}`))
  }

  const cpuSeries = history.map((h) => h.app.cpuPct)
  const memSeries = history.map((h) => h.app.rssTotal / (1024 * 1024))
  const hostCpuSeries = history.map((h) => h.host.cpuPct)
  const lagSeries = history.map((h) => h.main?.eventLoopLagMs ?? 0)

  const host = snapshot?.host
  // Use OS-accurate available memory, not memFree: on macOS the kernel reports
  // most cache/inactive RAM as non-free, so memFree-based "used" reads ~95%+ on
  // a healthy machine (the Activity-Monitor mismatch this panel had).
  const hostMemUsed = host ? host.memTotal - host.memAvailable : 0
  const hostMemPct = host && host.memTotal > 0 ? (hostMemUsed / host.memTotal) * 100 : 0
  const cpuCount = host?.cpuCount ?? 1

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-4xl" data-testid="monitor-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            System Monitor
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {snapshot && !snapshot.supported && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Per-process table is unavailable on this platform — showing host and server
              self-metrics only.
            </div>
          )}

          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Tile
              icon={Cpu}
              label="App CPU"
              value={snapshot ? formatPct(snapshot.app.cpuPct) : '—'}
              sub={`${snapshot?.app.procCount ?? 0} processes`}
              series={cpuSeries}
              strokeClassName="stroke-sky-500 text-sky-500"
            />
            <Tile
              icon={MemoryStick}
              label="App Memory"
              value={snapshot ? formatBytes(snapshot.app.rssTotal) : '—'}
              sub="resident set"
              series={memSeries}
              strokeClassName="stroke-violet-500 text-violet-500"
            />
            <Tile
              icon={Gauge}
              label="Host CPU"
              value={host ? `${host.cpuPct.toFixed(0)}%` : '—'}
              sub={`load ${host ? host.loadAvg1.toFixed(2) : '—'} · ${cpuCount} cores`}
              series={hostCpuSeries}
              max={100}
              strokeClassName="stroke-emerald-500 text-emerald-500"
            />
            <Tile
              icon={MemoryStick}
              label="Host Memory"
              value={host ? `${hostMemPct.toFixed(0)}%` : '—'}
              sub={host ? `${formatBytes(hostMemUsed)} / ${formatBytes(host.memTotal)}` : undefined}
              series={history.map((h) =>
                h.host.memTotal > 0
                  ? ((h.host.memTotal - h.host.memAvailable) / h.host.memTotal) * 100
                  : 0
              )}
              max={100}
              strokeClassName="stroke-amber-500 text-amber-500"
            />
          </div>

          {snapshot?.main && (
            <div className="text-xs text-muted-foreground">
              Server event-loop lag: <span className="tabular-nums">{snapshot.main.eventLoopLagMs.toFixed(1)} ms</span>
              {' · '}active handles: <span className="tabular-nums">{snapshot.main.handles.active}</span>
              <Sparkline values={lagSeries} width={120} height={16} className="inline-block ml-2 align-middle" strokeClassName="stroke-rose-500 text-rose-500" />
            </div>
          )}

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleCleanup} disabled={cleaning}>
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Force-cleanup orphans
            </Button>
            <Button size="sm" variant="outline" onClick={togglePause}>
              {paused ? <Play className="h-3.5 w-3.5 mr-1" /> : <Pause className="h-3.5 w-3.5 mr-1" />}
              {paused ? 'Resume sampling' : 'Pause sampling'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleOpenLog}>
              <FileText className="h-3.5 w-3.5 mr-1" />
              Open raw log
            </Button>
          </div>

          {/* Process table */}
          <ProcessTable processes={snapshot?.processes ?? []} onKill={handleKill} />

          {/* Alerts */}
          <div>
            <h4 className="text-sm font-medium mb-2">Recent alerts</h4>
            <AlertsFeed alerts={alerts} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
