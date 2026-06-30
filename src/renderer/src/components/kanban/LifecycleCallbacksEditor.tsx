import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Plus,
  RotateCcw,
  Trash2,
  Workflow
} from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { buildDefaultLoopConfig, type LifecycleSlot } from '@/lib/ticket-lifecycle'
import type {
  LifecycleAction,
  LifecycleActionType,
  LifecycleBranch,
  LifecycleEntryContext,
  LifecycleState,
  LifecycleStateConfig,
  LifecycleVerdict,
  TicketLifecycleConfig
} from '@shared/types/ticket-lifecycle'

/**
 * Full per-ticket builder for the lifecycle-callback model: a master enable
 * toggle plus a collapsible section per kanban state, each editing its four slot
 * lists — Before / Retry / During / After — with an ordered, typed action list
 * (prompt / agent / check / review / notify / goto / wait), verdict→goto branches,
 * and the retryMax loop-breaker. Entry slots (Before / Retry) expose a `runOn`
 * filter so an action can be scoped to the first (initial) entry or only loop
 * (retry) re-entries. Controlled: the parent owns the value so the modal's
 * dirty-check works. Emits a complete `TicketLifecycleConfig` (the master toggle
 * flips `enabled`); the parent decides whether to persist it.
 */

const STATES: LifecycleState[] = ['todo', 'in_progress', 'review', 'done']
const STATE_LABELS: Record<LifecycleState, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}
const SLOTS: { slot: LifecycleSlot; label: string; hint: string; entry: boolean }[] = [
  { slot: 'before', label: 'Before', hint: 'stable enter', entry: true },
  { slot: 'retry', label: 'Retry', hint: 'loop re-entry', entry: true },
  { slot: 'during', label: 'During', hint: 'while working', entry: false },
  { slot: 'after', label: 'After', hint: 'stable exit', entry: false }
]
const ACTION_TYPES: LifecycleActionType[] = [
  'prompt',
  'agent',
  'check',
  'review',
  'notify',
  'goto',
  'wait'
]
const VERDICTS: LifecycleVerdict[] = ['pass', 'fail', 'needsInput']
const GOTOS: (LifecycleState | 'end')[] = ['todo', 'in_progress', 'review', 'done', 'end']
const NOTIFY_EVENTS = ['started', 'question', 'stuck_review', 'done'] as const
const ENTRY_CONTEXTS: LifecycleEntryContext[] = ['initial', 'retry']

const EMPTY_CONFIG: TicketLifecycleConfig = { enabled: false, states: {} }

function newActionId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `lc_${Date.now().toString(36)}_${rand}`
}

function newAction(type: LifecycleActionType): LifecycleAction {
  // Seed the config with the value the editor shows as its default so a freshly
  // added action persists what the user sees (a `goto` left untouched would
  // otherwise have no `state` and silently no-op at runtime).
  const config: Record<string, unknown> =
    type === 'goto'
      ? { state: 'in_progress' }
      : type === 'notify'
        ? { event: 'started' }
        : type === 'wait'
          ? { seconds: 0 }
          : {}
  return { id: newActionId(), type, config }
}

export function LifecycleCallbacksEditor({
  value,
  onChange,
  defaults,
  className
}: {
  value: TicketLifecycleConfig | null
  onChange: (next: TicketLifecycleConfig | null) => void
  /** Global defaults used to seed the loop on enable / reset. */
  defaults: { maxIterations: number; fixPromptTemplate: string }
  className?: string
}): React.JSX.Element {
  const cfg = value ?? EMPTY_CONFIG
  const enabled = cfg.enabled === true
  const [expanded, setExpanded] = useState<Set<LifecycleState>>(
    () => new Set<LifecycleState>(['review', 'in_progress'])
  )

  // Produce the next config immutably and hand it up. `value` may be null; the
  // master toggle seeds a default loop when first enabled from empty.
  const emit = (producer: (draft: TicketLifecycleConfig) => void): void => {
    const draft: TicketLifecycleConfig = value
      ? structuredClone(value)
      : { enabled: true, states: {} }
    producer(draft)
    onChange(draft)
  }

  const toggleEnabled = (next: boolean): void => {
    if (next && (!value || Object.keys(value.states ?? {}).length === 0)) {
      // Enabling from empty → seed the canonical review↔fix loop.
      onChange(
        buildDefaultLoopConfig({
          maxIterations: defaults.maxIterations,
          fixPromptTemplate: defaults.fixPromptTemplate
        })
      )
      return
    }
    emit((d) => {
      d.enabled = next
    })
  }

  const resetToLoopDefault = (): void => {
    onChange(
      buildDefaultLoopConfig({
        maxIterations: defaults.maxIterations,
        fixPromptTemplate: defaults.fixPromptTemplate
      })
    )
  }

  const stateConfig = (state: LifecycleState): LifecycleStateConfig => cfg.states?.[state] ?? {}

  const setStateConfig = (
    state: LifecycleState,
    patch: (sc: LifecycleStateConfig) => void
  ): void => {
    emit((d) => {
      d.states = d.states ?? {}
      const sc = (d.states[state] = d.states[state] ?? {})
      patch(sc)
    })
  }

  const toggleExpanded = (state: LifecycleState): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(state)) next.delete(state)
      else next.add(state)
      return next
    })

  return (
    <div
      className={cn(
        'space-y-2.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5',
        className
      )}
      data-testid="lifecycle-editor"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Workflow className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
          Iterate Loop (lifecycle callbacks)
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={toggleEnabled}
          data-testid="lifecycle-enable-toggle"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Per-state Before / Retry / During / After actions, verdict branches, and a retry cap. The
        seeded loop re-prompts the agent with the reviewer&apos;s reason on each Review → In
        Progress bounce (the Retry slot).
      </p>

      {enabled && (
        <div className="space-y-2 pt-1">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetToLoopDefault}
              data-testid="lifecycle-reset"
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset to loop default
            </Button>
          </div>

          {STATES.map((state) => {
            const sc = stateConfig(state)
            const isOpen = expanded.has(state)
            const actionCount =
              (sc.before?.length ?? 0) +
              (sc.retry?.length ?? 0) +
              (sc.during?.length ?? 0) +
              (sc.after?.length ?? 0)
            return (
              <div
                key={state}
                className="rounded-md border border-border/60 bg-background/40"
                data-testid={`lifecycle-state-${state}`}
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(state)}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    {STATE_LABELS[state]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {actionCount > 0
                      ? `${actionCount} action${actionCount === 1 ? '' : 's'}`
                      : 'no actions'}
                    {sc.branches?.length ? ` · ${sc.branches.length} branch` : ''}
                    {typeof sc.retryMax === 'number' ? ` · max ${sc.retryMax}` : ''}
                  </span>
                </button>

                {isOpen && (
                  <div className="space-y-3 border-t border-border/60 px-2.5 py-2.5">
                    {SLOTS.map(({ slot, label, hint, entry }) => (
                      <SlotEditor
                        key={slot}
                        state={state}
                        slot={slot}
                        label={label}
                        hint={hint}
                        entry={entry}
                        actions={sc[slot] ?? []}
                        onActions={(actions) =>
                          setStateConfig(state, (s) => {
                            if (actions.length) s[slot] = actions
                            else delete s[slot]
                          })
                        }
                      />
                    ))}

                    <BranchesEditor
                      branches={sc.branches ?? []}
                      onBranches={(branches) =>
                        setStateConfig(state, (s) => {
                          if (branches.length) s.branches = branches
                          else delete s.branches
                        })
                      }
                    />

                    <div className="flex items-center gap-2">
                      <label className="text-xs font-medium text-muted-foreground">retryMax</label>
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        value={typeof sc.retryMax === 'number' ? sc.retryMax : ''}
                        placeholder="—"
                        onChange={(e) => {
                          const raw = e.target.value.trim()
                          const n = parseInt(raw, 10)
                          setStateConfig(state, (s) => {
                            if (raw === '' || isNaN(n)) delete s.retryMax
                            else s.retryMax = Math.max(1, Math.min(20, n))
                          })
                        }}
                        className="h-7 w-16 font-mono text-xs"
                        data-testid={`lifecycle-retrymax-${state}`}
                      />
                      <span className="text-[11px] text-muted-foreground">
                        bounces before stuck
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SlotEditor({
  state,
  slot,
  label,
  hint,
  entry,
  actions,
  onActions
}: {
  state: LifecycleState
  slot: LifecycleSlot
  label: string
  hint: string
  /** Entry slots (before/retry) expose the runOn initial/retry filter. */
  entry: boolean
  actions: LifecycleAction[]
  onActions: (actions: LifecycleAction[]) => void
}): React.JSX.Element {
  const addAction = (type: LifecycleActionType): void => onActions([...actions, newAction(type)])
  const removeAction = (id: string): void => onActions(actions.filter((a) => a.id !== id))
  const patchAction = (id: string, patch: Partial<LifecycleAction>): void =>
    onActions(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  const moveAction = (idx: number, dir: -1 | 1): void => {
    const next = idx + dir
    if (next < 0 || next >= actions.length) return
    const reordered = [...actions]
    const [item] = reordered.splice(idx, 1)
    reordered.splice(next, 0, item)
    onActions(reordered)
  }

  return (
    <div className="space-y-1.5" data-testid={`lifecycle-slot-${state}-${slot}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">
          {label} <span className="font-normal text-muted-foreground">({hint})</span>
        </span>
        <select
          value=""
          onChange={(e) => {
            const t = e.target.value as LifecycleActionType
            if (t) addAction(t)
            e.currentTarget.selectedIndex = 0
          }}
          className="h-6 rounded border border-border bg-background px-1 text-[11px]"
          data-testid={`lifecycle-add-${state}-${slot}`}
        >
          <option value="">+ add action…</option>
          {ACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {actions.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">none</p>
      ) : (
        <div className="space-y-1.5">
          {actions.map((action, idx) => (
            <div
              key={action.id}
              className="rounded border border-border/60 bg-muted/20 p-1.5"
              data-testid={`lifecycle-action-${action.id}`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                  {action.type}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveAction(idx, -1)}
                    disabled={idx === 0}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    aria-label="Move action up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveAction(idx, 1)}
                    disabled={idx === actions.length - 1}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    aria-label="Move action down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAction(action.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove action"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <ActionConfig
                action={action}
                onConfig={(config) => patchAction(action.id, { config })}
              />
              {entry && (
                <RunOnEditor
                  runOn={action.runOn}
                  onRunOn={(runOn) => patchAction(action.id, { runOn })}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Entry-context filter: initial / retry checkboxes. Both (or none) = runs on both. */
function RunOnEditor({
  runOn,
  onRunOn
}: {
  runOn: LifecycleEntryContext[] | undefined
  onRunOn: (next: LifecycleEntryContext[] | undefined) => void
}): React.JSX.Element {
  // Undefined or empty = runs on both (the lib treats both as "always").
  const isChecked = (ctx: LifecycleEntryContext): boolean =>
    !runOn || runOn.length === 0 || runOn.includes(ctx)

  const toggle = (ctx: LifecycleEntryContext): void => {
    const checked = ENTRY_CONTEXTS.filter((c) => (c === ctx ? !isChecked(c) : isChecked(c)))
    // Both checked (or none) → undefined (always); exactly one → that one.
    onRunOn(checked.length === 1 ? checked : undefined)
  }

  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
      <span>run on:</span>
      {ENTRY_CONTEXTS.map((ctx) => (
        <label key={ctx} className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={isChecked(ctx)}
            onChange={() => toggle(ctx)}
            className="h-3 w-3"
          />
          {ctx}
        </label>
      ))}
    </div>
  )
}

function ActionConfig({
  action,
  onConfig
}: {
  action: LifecycleAction
  onConfig: (config: Record<string, unknown>) => void
}): React.JSX.Element {
  const config = action.config ?? {}
  if (action.type === 'review') {
    return (
      <p className="text-[11px] text-muted-foreground">
        Runs the Strict Verify Reviewer (uses your global Strict Verify settings).
      </p>
    )
  }
  if (action.type === 'prompt' || action.type === 'agent') {
    const key = action.type === 'prompt' ? 'template' : 'prompt'
    const text = typeof config[key] === 'string' ? (config[key] as string) : ''
    return (
      <div className="space-y-1">
        <Textarea
          value={text}
          onChange={(e) => onConfig({ ...config, [key]: e.target.value })}
          rows={3}
          spellCheck={false}
          placeholder={
            action.type === 'prompt'
              ? "Message sent to the running agent. Use {{reason}} for the reviewer's reason."
              : 'Prompt the ticket agent is (re)launched with.'
          }
          className="w-full font-mono text-[11px] leading-relaxed"
        />
        <p className="text-[10px] text-muted-foreground">
          <code>{'{{reason}}'}</code>, <code>{'{{title}}'}</code>, <code>{'{{iteration}}'}</code>{' '}
          are substituted (reason appended if omitted).
        </p>
      </div>
    )
  }
  if (action.type === 'check') {
    const command = typeof config.command === 'string' ? config.command : ''
    return (
      <Input
        value={command}
        onChange={(e) => onConfig({ ...config, command: e.target.value })}
        placeholder="shell command (e.g. pnpm test) — runs in the worktree"
        className="h-7 font-mono text-[11px]"
      />
    )
  }
  if (action.type === 'goto') {
    const target = typeof config.state === 'string' ? config.state : 'in_progress'
    return (
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">go to</span>
        <select
          value={target}
          onChange={(e) => onConfig({ ...config, state: e.target.value })}
          className="h-7 rounded border border-border bg-background px-1"
        >
          {STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
    )
  }
  if (action.type === 'wait') {
    const seconds = typeof config.seconds === 'number' ? config.seconds : ''
    return (
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">wait</span>
        <Input
          type="number"
          min={0}
          value={seconds}
          onChange={(e) => {
            const n = parseFloat(e.target.value)
            onConfig({ ...config, seconds: isNaN(n) ? 0 : Math.max(0, n) })
          }}
          className="h-7 w-20 font-mono text-[11px]"
        />
        <span className="text-muted-foreground">seconds</span>
      </div>
    )
  }
  // notify
  const event = typeof config.event === 'string' ? config.event : 'started'
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={event}
        onChange={(e) => onConfig({ ...config, event: e.target.value })}
        className="h-7 rounded border border-border bg-background px-1 text-[11px]"
      >
        {NOTIFY_EVENTS.map((ev) => (
          <option key={ev} value={ev}>
            {ev}
          </option>
        ))}
      </select>
      <span className="text-[10px] text-muted-foreground">Telegram notification</span>
    </div>
  )
}

function BranchesEditor({
  branches,
  onBranches
}: {
  branches: LifecycleBranch[]
  onBranches: (branches: LifecycleBranch[]) => void
}): React.JSX.Element {
  const addBranch = (): void => onBranches([...branches, { when: 'fail', goto: 'in_progress' }])
  const removeBranch = (idx: number): void => onBranches(branches.filter((_, i) => i !== idx))
  const patchBranch = (idx: number, patch: Partial<LifecycleBranch>): void =>
    onBranches(branches.map((b, i) => (i === idx ? { ...b, ...patch } : b)))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">Branches</span>
        <button
          type="button"
          onClick={addBranch}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="lifecycle-add-branch"
        >
          <Plus className="h-3 w-3" /> add
        </button>
      </div>
      {branches.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">none</p>
      ) : (
        <div className="space-y-1">
          {branches.map((branch, idx) => (
            <div key={idx} className="flex items-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground">when</span>
              <select
                value={branch.when}
                onChange={(e) => patchBranch(idx, { when: e.target.value as LifecycleVerdict })}
                className="h-7 rounded border border-border bg-background px-1"
              >
                {VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">→</span>
              <select
                value={branch.goto}
                onChange={(e) =>
                  patchBranch(idx, { goto: e.target.value as LifecycleState | 'end' })
                }
                className="h-7 rounded border border-border bg-background px-1"
              >
                {GOTOS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeBranch(idx)}
                className="ml-auto text-muted-foreground hover:text-destructive"
                aria-label="Remove branch"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
