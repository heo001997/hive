import { useMemo, useState } from 'react'
import { Skull } from 'lucide-react'
import type { MonitorProcess, MonitorProcessFlag } from '@shared/system-monitor-events'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from '@/components/ui/alert-dialog'
import { formatBytes, formatPct, processTypeLabel, shouldGroupKill } from './format'

type SortKey = 'cpuPct' | 'rss' | 'pid' | 'type'

interface ProcessTableProps {
  processes: MonitorProcess[]
  onKill: (pid: number, group: boolean) => void
}

const FLAG_STYLES: Record<MonitorProcessFlag, string> = {
  HIGH: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  ORPHAN: 'bg-red-500/15 text-red-600 dark:text-red-400',
  RSS_GROWTH: 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
}

function HeaderCell({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  className
}: {
  label: string
  sortKey: SortKey
  activeKey: SortKey
  dir: 'asc' | 'desc'
  onSort: (key: SortKey) => void
  className?: string
}): React.JSX.Element {
  const active = activeKey === sortKey
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        'flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors',
        className
      )}
    >
      {label}
      {active && <span className="text-[10px]">{dir === 'desc' ? '▼' : '▲'}</span>}
    </button>
  )
}

export function ProcessTable({ processes, onKill }: ProcessTableProps): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('cpuPct')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [confirm, setConfirm] = useState<{ pid: number; label: string; group: boolean } | null>(null)

  const handleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setDir(key === 'type' ? 'asc' : 'desc')
    }
  }

  const sorted = useMemo(() => {
    const factor = dir === 'desc' ? -1 : 1
    return [...processes].sort((a, b) => {
      if (sortKey === 'type') return factor * a.type.localeCompare(b.type)
      return factor * (a[sortKey] - b[sortKey])
    })
  }, [processes, sortKey, dir])

  if (processes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No processes sampled yet.
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="grid grid-cols-[1fr_64px_72px_84px_40px] gap-2 px-3 py-2 border-b border-border bg-muted/40">
        <HeaderCell label="Process" sortKey="type" activeKey={sortKey} dir={dir} onSort={handleSort} />
        <HeaderCell
          label="PID"
          sortKey="pid"
          activeKey={sortKey}
          dir={dir}
          onSort={handleSort}
          className="justify-end"
        />
        <HeaderCell
          label="CPU"
          sortKey="cpuPct"
          activeKey={sortKey}
          dir={dir}
          onSort={handleSort}
          className="justify-end"
        />
        <HeaderCell
          label="RSS"
          sortKey="rss"
          activeKey={sortKey}
          dir={dir}
          onSort={handleSort}
          className="justify-end"
        />
        <span />
      </div>

      <div className="max-h-[320px] overflow-y-auto">
        {sorted.map((p) => (
          <div
            key={p.pid}
            className="grid grid-cols-[1fr_64px_72px_84px_40px] gap-2 px-3 py-1.5 items-center border-b border-border/50 last:border-0 hover:bg-muted/30 text-sm"
          >
            <div className="min-w-0 flex items-center gap-2">
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {processTypeLabel(p.type)}
              </span>
              <span className="truncate" title={p.label}>
                {p.label}
              </span>
              {p.flags.map((flag) => (
                <span
                  key={flag}
                  className={cn(
                    'shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold',
                    FLAG_STYLES[flag]
                  )}
                >
                  {flag}
                </span>
              ))}
            </div>
            <span className="text-right tabular-nums text-muted-foreground">{p.pid}</span>
            <span
              className={cn(
                'text-right tabular-nums',
                p.cpuPct >= 80 && 'text-amber-600 dark:text-amber-400 font-medium'
              )}
            >
              {formatPct(p.cpuPct)}
            </span>
            <span className="text-right tabular-nums">{formatBytes(p.rss)}</span>
            <button
              type="button"
              onClick={() =>
                setConfirm({ pid: p.pid, label: p.label, group: shouldGroupKill(p.type) })
              }
              title={`Kill ${p.label} (pid ${p.pid})`}
              className="justify-self-end text-muted-foreground hover:text-destructive transition-colors p-1"
              data-testid={`monitor-kill-${p.pid}`}
            >
              <Skull className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill process?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && (
                <>
                  Send SIGTERM to &ldquo;{confirm.label}&rdquo; (pid {confirm.pid})
                  {confirm.group ? ' and its whole process group' : ''}? A SIGKILL backstop follows
                  if it doesn&rsquo;t exit.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirm) onKill(confirm.pid, confirm.group)
                setConfirm(null)
              }}
            >
              Kill process
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
