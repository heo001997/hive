import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Circle,
  ClipboardList,
  FileText,
  GitPullRequest,
  Hammer,
  HelpCircle,
  Layers,
  ListChecks,
  ListTodo,
  Map as MapIcon,
  MessageSquare,
  Search,
  ShieldCheck,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { systemApi } from '@/api/system-api'
import { NODE_H, NODE_W, type WorkflowNode, type WorkflowPhase, type WorkflowStatus } from './lib/workflow-graph'

const PHASE_META: Record<WorkflowPhase, { icon: LucideIcon; label: string }> = {
  specify: { icon: FileText, label: 'Specify' },
  clarify: { icon: HelpCircle, label: 'Clarify' },
  checklist: { icon: ListChecks, label: 'Checklist' },
  plan: { icon: MapIcon, label: 'Plan' },
  tasks: { icon: ListTodo, label: 'Tasks' },
  analyze: { icon: Search, label: 'Analyze' },
  implement: { icon: Hammer, label: 'Implement' },
  'review-plan': { icon: ClipboardList, label: 'Review plan' },
  review: { icon: ShieldCheck, label: 'Review' },
  fix: { icon: Wrench, label: 'Fix' },
  feedback: { icon: MessageSquare, label: 'Feedback' },
  'feedback-fix': { icon: Wrench, label: 'Feedback fix' },
  shard: { icon: Layers, label: 'Shard' },
  generic: { icon: Circle, label: 'Task' }
}

// Semantic tokens only (see globals.css) — never `dark:` prefixes.
const STATUS_META: Record<WorkflowStatus, { color: string; label: string }> = {
  done: { color: 'var(--chart-2)', label: 'Done' },
  running: { color: 'var(--primary)', label: 'Running' },
  review: { color: 'var(--chart-4)', label: 'Review' },
  blocked: { color: 'var(--chart-4)', label: 'Blocked' },
  todo: { color: 'var(--muted-foreground)', label: 'To do' }
}

const VERDICT_META: Record<string, { color: string; label: string }> = {
  pass: { color: 'var(--chart-2)', label: 'pass' },
  fix: { color: 'var(--chart-4)', label: 'fix' },
  'needs-human': { color: 'var(--destructive)', label: 'needs human' }
}

/**
 * A single workflow ticket rendered as a DAG node. Presentational only — opening
 * the ticket is handled by `onNodeDoubleClick` on the parent `<ReactFlow>` (see
 * `WorkflowGraph`), which keeps node data serializable (no embedded callbacks).
 */
function TicketNodeImpl({ data }: NodeProps<WorkflowNode>) {
  const phaseMeta = PHASE_META[data.phase]
  const statusMeta = STATUS_META[data.status]
  const PhaseIcon = phaseMeta.icon
  const verdictMeta = data.gateVerdict ? VERDICT_META[data.gateVerdict] : null

  return (
    <div
      className="relative"
      style={{ width: NODE_W, height: NODE_H }}
      title="Double-click to open ticket"
    >
      {/* Incoming (from blockers, top) / outgoing (to dependents, bottom) handles. */}
      <Handle type="target" position={Position.Top} className="!bg-border !border-0 !h-1.5 !w-1.5" />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-border !border-0 !h-1.5 !w-1.5"
      />

      {/* Running pulse ring. */}
      {data.pulse && (
        <div
          className="pointer-events-none absolute inset-0 rounded-lg animate-pulse"
          style={{ boxShadow: `0 0 0 2px ${statusMeta.color}` }}
        />
      )}

      <div
        className={cn(
          'flex h-full w-full flex-col gap-1.5 rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-sm transition-shadow',
          data.isActive && 'shadow-md',
          data.isGate && 'border-dashed'
        )}
        style={{
          borderColor: statusMeta.color,
          borderWidth: data.isActive ? 2 : 1
        }}
      >
        {/* Header: phase icon + label, round + gate badges. */}
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <PhaseIcon className="h-3.5 w-3.5 shrink-0" style={{ color: statusMeta.color }} />
          <span className="truncate">{phaseMeta.label}</span>
          <div className="ml-auto flex items-center gap-1">
            {data.round > 0 && (
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none">
                ↻{data.round}
              </span>
            )}
            {data.isShardGate ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                style={{ backgroundColor: 'color-mix(in srgb, var(--chart-4) 20%, transparent)', color: 'var(--chart-4)' }}
              >
                shard gate
              </span>
            ) : data.isGate ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                style={{ backgroundColor: 'color-mix(in srgb, var(--primary) 18%, transparent)', color: 'var(--primary)' }}
              >
                gate
              </span>
            ) : null}
          </div>
        </div>

        {/* Title. */}
        <div className="line-clamp-2 text-xs font-medium leading-snug text-foreground">
          {data.title}
        </div>

        {/* Footer: status dot + label, verdict, PR chip. */}
        <div className="mt-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: statusMeta.color }}
          />
          <span data-testid="workflow-node-status">{statusMeta.label}</span>
          {verdictMeta && (
            <span
              className="rounded-full px-1.5 py-0.5 leading-none"
              style={{
                backgroundColor: `color-mix(in srgb, ${verdictMeta.color} 20%, transparent)`,
                color: verdictMeta.color
              }}
            >
              {verdictMeta.label}
            </span>
          )}
          {data.prNumber != null && data.prUrl && (
            <button
              type="button"
              className="nodrag ml-auto inline-flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 leading-none hover:bg-muted"
              title={`Open PR #${data.prNumber} in browser`}
              onClick={(e) => {
                e.stopPropagation()
                systemApi.openInChrome(data.prUrl as string)
              }}
            >
              <GitPullRequest className="h-3 w-3" />#{data.prNumber}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export const TicketNode = memo(TicketNodeImpl)

/** Non-interactive board lane label (root title + running indicator). */
function LaneLabelImpl({ data }: NodeProps) {
  const d = data as { title: string; running: boolean }
  return (
    <div className="pointer-events-none flex max-w-[280px] items-center gap-2 text-sm font-semibold text-foreground">
      {d.running && (
        <span
          className="h-2 w-2 shrink-0 rounded-full animate-pulse"
          style={{ backgroundColor: 'var(--primary)' }}
        />
      )}
      <span className="truncate">{d.title}</span>
    </div>
  )
}

export const LaneLabelNode = memo(LaneLabelImpl)
