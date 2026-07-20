import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Flag,
  ListTodo,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Sparkles,
  Swords,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  hasBoardDraftBlock,
  parseBoardAssistantDraftSet,
  removeBoardDraftBlocks
} from '@/lib/board-assistant-drafts'
import {
  createTicketsFromDrafts,
  type CreatableTicketDraft
} from '@/lib/create-tickets-from-drafts'
import { useWarRoomStore } from '@/stores/useWarRoomStore'
import { MemberEditModal } from './MemberEditModal'
import { OutcomePanel } from './OutcomePanel'
import type { WarRoom, WarRoomMember, WarRoomStatus } from '../../../../main/db/types'

const STATUS_META: Record<WarRoomStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
  active: { label: 'Running', className: 'bg-blue-500/15 text-blue-500' },
  paused: { label: 'Paused', className: 'bg-yellow-500/15 text-yellow-500' },
  awaiting_ceo: { label: 'Awaiting CEO', className: 'bg-amber-500/20 text-amber-500' },
  concluded: { label: 'Concluded', className: 'bg-green-500/15 text-green-500' },
  achieved: { label: 'Achieved', className: 'bg-green-500/20 text-green-500' }
}

function StatusBadge({ status }: { status: WarRoomStatus }): React.JSX.Element {
  const meta = STATUS_META[status] ?? STATUS_META.draft
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        meta.className
      )}
    >
      {status === 'active' ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {meta.label}
    </span>
  )
}

// ── Room list ────────────────────────────────────────────────────────────────

function RoomList({
  projectId,
  scope,
  setScope,
  hasProject
}: {
  projectId: string | null
  scope: 'project' | 'standalone'
  setScope: (s: 'project' | 'standalone') => void
  hasProject: boolean
}): React.JSX.Element {
  const rooms = useWarRoomStore((s) => s.rooms)
  const isLoading = useWarRoomStore((s) => s.isLoading)
  const openRoom = useWarRoomStore((s) => s.openRoom)
  const createRoom = useWarRoomStore((s) => s.createRoom)

  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [topic, setTopic] = useState('')
  const [maxRounds, setMaxRounds] = useState(3)
  const [creating, setCreating] = useState(false)

  const handleCreate = async (): Promise<void> => {
    if (!title.trim()) return
    setCreating(true)
    try {
      const room = await createRoom({
        projectId,
        title: title.trim(),
        topic: topic.trim(),
        maxRounds
      })
      setShowCreate(false)
      setTitle('')
      setTopic('')
      setMaxRounds(3)
      await openRoom(room.id)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Swords className="h-5 w-5 text-amber-500" />
          <div>
            <h1 className="text-lg font-semibold">War Rooms</h1>
            <p className="text-xs text-muted-foreground">
              Agents debate, you preside as CEO
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasProject ? (
            <div className="flex overflow-hidden rounded-md border border-border text-xs">
              <button
                className={cn(
                  'px-3 py-1.5',
                  scope === 'project' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                )}
                onClick={() => setScope('project')}
              >
                Project
              </button>
              <button
                className={cn(
                  'px-3 py-1.5',
                  scope === 'standalone'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground'
                )}
                onClick={() => setScope('standalone')}
              >
                Standalone
              </button>
            </div>
          ) : null}
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            New War Room
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : rooms.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <Swords className="h-8 w-8 opacity-40" />
          <p className="text-sm">No war rooms yet.</p>
          <p className="text-xs">Create one and add AI agents to start a discussion.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 overflow-y-auto">
          {rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => openRoom(room.id)}
              className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{room.title}</span>
                <StatusBadge status={room.status} />
              </div>
              {room.topic ? (
                <span className="line-clamp-1 text-xs text-muted-foreground">{room.topic}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={(v) => !v && setShowCreate(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New War Room</DialogTitle>
            <DialogDescription>
              Set the topic. A default roster (Architect, Skeptic, Product) is added — edit it after.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Should we adopt tRPC?"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Topic / opening question
              </label>
              <Textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What we want the room to decide…"
                rows={3}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Max rounds
              </label>
              <Input
                type="number"
                min={1}
                max={20}
                value={maxRounds}
                onChange={(e) => setMaxRounds(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                className="w-24"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !title.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Roster ──────────────────────────────────────────────────────────────────

function Roster({
  roomId,
  members,
  thinkingMemberId,
  disabled
}: {
  roomId: string
  members: WarRoomMember[]
  thinkingMemberId: string | null
  disabled: boolean
}): React.JSX.Element {
  const removeMember = useWarRoomStore((s) => s.removeMember)
  const [editing, setEditing] = useState<WarRoomMember | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  return (
    <div className="flex w-56 shrink-0 flex-col gap-1 border-r border-border p-2">
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Roster
      </div>
      {members.map((m) => (
        <div
          key={m.id}
          className={cn(
            'group flex items-center gap-2 rounded-md px-2 py-1.5',
            thinkingMemberId === m.id && 'bg-accent'
          )}
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
            style={{ backgroundColor: m.color ?? '#8b949e' }}
          >
            {m.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 truncate text-sm">
              {m.name}
              {thinkingMemberId === m.id ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : null}
            </div>
            {m.role ? <div className="truncate text-[11px] text-muted-foreground">{m.role}</div> : null}
          </div>
          {!disabled ? (
            <div className="hidden gap-0.5 group-hover:flex">
              <button
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(m)}
                title="Edit"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                className="rounded p-1 text-muted-foreground hover:text-destructive"
                onClick={() => removeMember(m.id)}
                title="Remove"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 justify-start text-muted-foreground"
        onClick={() => setShowAdd(true)}
        disabled={disabled}
      >
        <Plus className="h-3.5 w-3.5" />
        Add agent
      </Button>

      <MemberEditModal
        open={showAdd || editing !== null}
        roomId={roomId}
        member={editing}
        onClose={() => {
          setShowAdd(false)
          setEditing(null)
        }}
      />
    </div>
  )
}

// ── Inline task drafts (like the Board Assistant) ───────────────────────────────

function MessageDrafts({
  content,
  projectId
}: {
  content: string
  projectId: string | null
}): React.JSX.Element | null {
  const parsed = useMemo(
    () =>
      parseBoardAssistantDraftSet(content, {
        fallbackProjectId: projectId,
        requireExplicitDraftKeys: false
      }),
    [content, projectId]
  )
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)

  if (!parsed || parsed.drafts.length === 0) return null
  const canCreate = Boolean(projectId) && !created

  const handleCreate = async (): Promise<void> => {
    if (!projectId) return
    setCreating(true)
    try {
      const drafts: CreatableTicketDraft[] = parsed.drafts.map((d) => ({
        id: crypto.randomUUID(),
        draftKey: d.draftKey,
        title: d.title,
        description: d.description,
        projectId,
        dependsOn: d.dependsOn ?? []
      }))
      const res = await createTicketsFromDrafts(drafts, { mode: 'build' })
      if (res.failures.length > 0) {
        toast.error(`Created ${res.ticketCount}, ${res.failures.length} failed`)
      } else {
        toast.success(`Created ${res.ticketCount} ticket${res.ticketCount === 1 ? '' : 's'}`)
      }
      setCreated(true)
    } catch (err) {
      toast.error(`Failed to create tickets: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mt-1.5 rounded-md border border-blue-500/30 bg-blue-500/5 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-blue-400">
        <ListTodo className="h-3.5 w-3.5" />
        Proposed tickets
      </div>
      <ul className="list-disc pl-4 text-xs">
        {parsed.drafts.map((d, i) => (
          <li key={i}>{d.title}</li>
        ))}
      </ul>
      {canCreate ? (
        <Button size="sm" className="mt-2" onClick={handleCreate} disabled={creating}>
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListTodo className="h-3.5 w-3.5" />}
          Create {parsed.drafts.length} ticket{parsed.drafts.length === 1 ? '' : 's'}
        </Button>
      ) : created ? (
        <p className="mt-1.5 text-xs text-green-500">✓ Created on the board.</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Attach this room to a project to create tickets.
        </p>
      )}
    </div>
  )
}

// ── Transcript ────────────────────────────────────────────────────────────────

function Transcript({
  detail,
  thinkingMemberName
}: {
  detail: NonNullable<ReturnType<typeof useWarRoomStore.getState>['detail']>
  thinkingMemberName: string | null
}): React.JSX.Element {
  const memberById = useMemo(
    () => new Map(detail.members.map((m) => [m.id, m])),
    [detail.members]
  )

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {detail.messages.length === 0 ? (
        <div className="m-auto text-center text-sm text-muted-foreground">
          Press <span className="font-medium text-foreground">Start</span> to begin the discussion.
        </div>
      ) : null}

      {detail.messages.map((msg) => {
        if (msg.role === 'system') {
          return (
            <div key={msg.id} className="mx-auto max-w-2xl text-center">
              <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                Topic: {msg.content}
              </span>
            </div>
          )
        }
        if (msg.role === 'ceo') {
          return (
            <div key={msg.id} className="ml-auto max-w-[80%]">
              <div className="mb-0.5 text-right text-[11px] font-semibold text-amber-500">CEO</div>
              <div className="rounded-lg rounded-tr-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                {msg.content}
              </div>
            </div>
          )
        }
        const member = msg.member_id ? memberById.get(msg.member_id) : undefined
        const color = member?.color ?? '#8b949e'
        const hasDrafts = hasBoardDraftBlock(msg.content)
        const displayText = hasDrafts ? removeBoardDraftBlocks(msg.content).trim() : msg.content
        return (
          <div key={msg.id} className="mr-auto max-w-[80%]">
            <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color }}>
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] text-black"
                style={{ backgroundColor: color }}
              >
                {(member?.name ?? '?').slice(0, 1).toUpperCase()}
              </span>
              {member?.name ?? 'Unknown'}
              {msg.needs_ceo ? <Flag className="h-3 w-3 text-amber-500" /> : null}
            </div>
            <div className="whitespace-pre-wrap rounded-lg rounded-tl-sm border border-border bg-card px-3 py-2 text-sm">
              {displayText}
            </div>
            {hasDrafts ? (
              <MessageDrafts content={msg.content} projectId={detail.room.project_id} />
            ) : null}
          </div>
        )
      })}

      {thinkingMemberName ? (
        <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {thinkingMemberName} is thinking…
        </div>
      ) : null}
    </div>
  )
}

// ── Edit room ────────────────────────────────────────────────────────────────

function EditRoomDialog({
  room,
  open,
  onClose,
  onSave
}: {
  room: WarRoom
  open: boolean
  onClose: () => void
  onSave: (data: { title: string; topic: string; max_rounds: number }) => Promise<void>
}): React.JSX.Element {
  const [title, setTitle] = useState(room.title)
  const [topic, setTopic] = useState(room.topic ?? '')
  const [maxRounds, setMaxRounds] = useState(room.max_rounds)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(room.title)
    setTopic(room.topic ?? '')
    setMaxRounds(room.max_rounds)
    setSaving(false)
  }, [open, room.title, room.topic, room.max_rounds])

  const handleSave = async (): Promise<void> => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await onSave({ title: title.trim(), topic: topic.trim(), max_rounds: maxRounds })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit room</DialogTitle>
          <DialogDescription>Adjust the title, topic, and round cap.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Topic</label>
            <Textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Max rounds
            </label>
            <Input
              type="number"
              min={1}
              max={20}
              value={maxRounds}
              onChange={(e) => setMaxRounds(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
              className="w-24"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !title.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Room detail ────────────────────────────────────────────────────────────────

function RoomDetail(): React.JSX.Element | null {
  const detail = useWarRoomStore((s) => s.detail)
  const isDetailLoading = useWarRoomStore((s) => s.isDetailLoading)
  const thinkingMemberId = useWarRoomStore((s) => s.thinkingMemberId)
  const thinkingMemberName = useWarRoomStore((s) => s.thinkingMemberName)
  const ceoQuestion = useWarRoomStore((s) => s.ceoQuestion)
  const ceoAskedBy = useWarRoomStore((s) => s.ceoAskedBy)
  const lastError = useWarRoomStore((s) => s.lastError)
  const closeRoom = useWarRoomStore((s) => s.closeRoom)
  const deleteRoom = useWarRoomStore((s) => s.deleteRoom)
  const start = useWarRoomStore((s) => s.start)
  const pause = useWarRoomStore((s) => s.pause)
  const achieve = useWarRoomStore((s) => s.achieve)
  const injectCeo = useWarRoomStore((s) => s.injectCeo)
  const updateRoom = useWarRoomStore((s) => s.updateRoom)

  const [ceoText, setCeoText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | 'achieve' | null>(null)
  const [showEdit, setShowEdit] = useState(false)

  if (isDetailLoading || !detail) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  const room: WarRoom = detail.room
  const status = room.status
  const running = status === 'active'
  // Terminal = the CEO pressed Achieve (legacy auto-'concluded' rooms are terminal too).
  const terminal = status === 'achieved' || status === 'concluded'
  const hasMessages = detail.messages.length > 0
  const canStart = status === 'draft' && !hasMessages
  const isPaused = status === 'paused' || status === 'awaiting_ceo'
  // Send doubles as resume/continue: enabled when there's text, or when paused so
  // the CEO can nudge the discussion onward without typing.
  const canSend = !terminal && (ceoText.trim().length > 0 || isPaused)

  const withBusy = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const sendCeo = async (): Promise<void> => {
    if (!canSend) return
    const text = ceoText
    setCeoText('')
    try {
      await injectCeo(text)
    } catch (err) {
      setCeoText(text) // restore so the CEO doesn't lose their message
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Button variant="ghost" size="icon" onClick={closeRoom} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{room.title}</span>
            <StatusBadge status={status} />
          </div>
          {room.topic ? (
            <div className="truncate text-xs text-muted-foreground">{room.topic}</div>
          ) : null}
        </div>
        {!terminal && hasMessages ? (
          <Button
            size="sm"
            variant="outline"
            className="border-green-600/50 text-green-600 hover:bg-green-500/10"
            onClick={() => setConfirm('achieve')}
            disabled={busy}
            title="Finalize: synthesize the agreement and lock the room. Only the CEO can do this."
          >
            <CheckCircle2 className="h-4 w-4" />
            Achieve
          </Button>
        ) : null}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>
            Round {Math.min(room.current_round + (running ? 1 : 0), room.max_rounds)}/
            {room.max_rounds}
          </span>
          <span className="mx-1">·</span>
          <Sparkles className="h-3 w-3" />
          <span>{(room.total_tokens / 1000).toFixed(1)}k</span>
        </div>
        {!terminal ? (
          <Button variant="ghost" size="icon" onClick={() => setShowEdit(true)} title="Edit room">
            <Pencil className="h-4 w-4" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setConfirm('delete')}
          title="Delete room"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <Roster
          roomId={room.id}
          members={detail.members}
          thinkingMemberId={thinkingMemberId}
          disabled={running}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Transcript detail={detail} thinkingMemberName={thinkingMemberName} />

          {lastError ? (
            <div className="mx-4 mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              {lastError}
            </div>
          ) : null}

          {room.outcome ? (
            <div className="px-4 pb-3">
              <OutcomePanel room={room} />
            </div>
          ) : null}

          {ceoQuestion ? (
            <div className="mx-4 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <div className="flex items-center gap-1.5 font-medium text-amber-500">
                <Flag className="h-3.5 w-3.5" />
                {ceoAskedBy ?? 'An agent'} needs your call
              </div>
              <div className="mt-0.5 text-foreground">{ceoQuestion}</div>
            </div>
          ) : null}

          {/* Control bar — the room never auto-stops; only Achieve (top bar) ends it. */}
          {!terminal ? (
            <div className="border-t border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                {canStart ? (
                  <Button size="sm" onClick={() => withBusy(start)} disabled={busy}>
                    <Play className="h-4 w-4" />
                    Start
                  </Button>
                ) : null}
                {running ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => withBusy(pause)}
                    disabled={busy}
                  >
                    <Pause className="h-4 w-4" />
                    Pause
                  </Button>
                ) : null}
                {isPaused ? (
                  <span className="text-xs text-muted-foreground">
                    Paused — send a message to continue, or Achieve to finalize.
                  </span>
                ) : null}
              </div>
              <div className="flex items-end gap-2">
                <Textarea
                  value={ceoText}
                  onChange={(e) => setCeoText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void sendCeo()
                    }
                  }}
                  placeholder={
                    ceoQuestion
                      ? 'Answer the escalation as CEO… (⌘/Ctrl+Enter)'
                      : isPaused
                        ? 'Send to continue the discussion, or add a steer… (⌘/Ctrl+Enter)'
                        : 'Step in as CEO — steer, decide, or add a constraint… (⌘/Ctrl+Enter)'
                  }
                  rows={2}
                  className="resize-none"
                />
                <Button
                  size="icon"
                  onClick={() => void sendCeo()}
                  disabled={!canSend}
                  title="Send as CEO"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 border-t border-border p-3 text-xs text-green-500">
              <CheckCircle2 className="h-3.5 w-3.5" />
              This room has been achieved — locked.
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'achieve' ? 'Achieve this room?' : 'Delete this room?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'achieve'
                ? 'This synthesizes the final agreement and locks the room. It cannot be reopened for discussion.'
                : 'This permanently deletes the room, its roster and transcript. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirm === 'delete'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : ''
              }
              onClick={() => {
                const action = confirm
                setConfirm(null)
                if (action === 'achieve') void withBusy(achieve)
                else if (action === 'delete') void withBusy(() => deleteRoom(room.id))
              }}
            >
              {confirm === 'achieve' ? 'Achieve' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditRoomDialog
        room={room}
        open={showEdit}
        onClose={() => setShowEdit(false)}
        onSave={async (data) => {
          await updateRoom(room.id, data)
          setShowEdit(false)
        }}
      />
    </div>
  )
}

// ── Surface entry ────────────────────────────────────────────────────────────

export function WarRoomView({ projectId }: { projectId: string | null }): React.JSX.Element {
  const activeRoomId = useWarRoomStore((s) => s.activeRoomId)
  const roomsLoadedFor = useWarRoomStore((s) => s.roomsLoadedFor)
  const loadRooms = useWarRoomStore((s) => s.loadRooms)
  const closeRoom = useWarRoomStore((s) => s.closeRoom)
  const ensureSubscription = useWarRoomStore((s) => s.ensureSubscription)

  const [scope, setScope] = useState<'project' | 'standalone'>('project')
  // With no project selected, only standalone rooms make sense.
  const effectiveScope: 'project' | 'standalone' = projectId ? scope : 'standalone'
  const effectiveProjectId = effectiveScope === 'standalone' ? null : projectId

  useEffect(() => {
    ensureSubscription()
  }, [ensureSubscription])

  useEffect(() => {
    if (roomsLoadedFor !== effectiveProjectId) {
      closeRoom()
      void loadRooms(effectiveProjectId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId])

  return (
    <div className="h-full w-full bg-background">
      {activeRoomId ? (
        <RoomDetail />
      ) : (
        <RoomList
          projectId={effectiveProjectId}
          scope={effectiveScope}
          setScope={setScope}
          hasProject={Boolean(projectId)}
        />
      )}
    </div>
  )
}
