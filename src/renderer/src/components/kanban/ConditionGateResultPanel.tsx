import { AlertTriangle, CheckCircle2, Clock, ShieldCheck, Wrench, XCircle } from 'lucide-react'
import type { ConditionGateResult } from '@shared/types/completion'

/**
 * Shows the last recorded Condition-Gate run on a ticket — the durable answer to
 * "did the two-stage gate run, and how did it decide?". Fed by the persisted
 * `ticket.condition_gate_result` (written by `runConditionGate`), so it survives
 * reloads and shows even after the gate moved the ticket to Done.
 */
export function ConditionGateResultPanel({
  result
}: {
  result: ConditionGateResult
}): React.JSX.Element {
  const tone = toneFor(result)
  const Icon = tone.icon
  return (
    <div
      data-testid="condition-gate-result"
      className={`rounded-md border px-3 py-2.5 text-xs ${tone.box}`}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span>Condition Gate</span>
        <span className="ml-auto flex items-center gap-1 font-normal opacity-70">
          <Clock className="h-3 w-3" />
          {formatWhen(result.ranAt)} · {result.trigger === 'manual' ? 'manual re-run' : 'auto'}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="font-semibold uppercase tracking-wide">{tone.label}</span>
        {result.round > 0 && (
          <span className="opacity-70">
            · round {result.round}/{result.maxRounds}
          </span>
        )}
        {result.source && (
          <span
            className="ml-auto rounded bg-black/5 px-1.5 py-0.5 text-[10px] opacity-80 dark:bg-white/10"
            title="Where the verdict came from"
          >
            {result.source === 'review-gate.json' ? 'review-gate.json' : 'LLM transcript'}
          </span>
        )}
      </div>

      {/* What the engine actually did next — the part the logs never persisted. */}
      <div className="mt-1 text-foreground/80">{result.action}</div>

      {result.reason && (
        <div className="mt-1 text-foreground/60">
          <span className="opacity-70">Reason: </span>
          {result.reason}
        </div>
      )}

      {result.error && (
        <div className="mt-1 font-mono text-[11px] text-red-500 dark:text-red-400">
          {result.error}
        </div>
      )}

      {result.fixes.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-foreground/70">
          {result.fixes.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function toneFor(result: ConditionGateResult): {
  label: string
  box: string
  icon: typeof CheckCircle2
} {
  if (result.decision === 'error') {
    return {
      label: 'Gate error',
      box: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
      icon: XCircle
    }
  }
  switch (result.verdict) {
    case 'pass':
      return {
        label: 'Pass',
        box: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        icon: CheckCircle2
      }
    case 'fix':
      return {
        label: 'Fix',
        box: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
        icon: Wrench
      }
    case 'needs-human':
    default:
      return {
        label: 'Needs human',
        box: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        icon: AlertTriangle
      }
  }
}

function formatWhen(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}
