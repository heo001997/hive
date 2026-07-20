import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useWarRoomStore } from '@/stores/useWarRoomStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { opencodeApi } from '@/api/opencode-api'
import { parseProviders } from '@/lib/parseProviders'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { toast } from '@/lib/toast'
import type { WarRoomMember } from '../../../../main/db/types'

type ProviderId = 'claude-code' | 'codex' | 'opencode'

const PROVIDERS: Array<{ id: ProviderId; label: string; availKey: 'claude' | 'codex' | 'opencode' }> =
  [
    { id: 'claude-code', label: 'Claude Code', availKey: 'claude' },
    { id: 'codex', label: 'Codex', availKey: 'codex' },
    { id: 'opencode', label: 'OpenCode', availKey: 'opencode' }
  ]

const COLORS = ['#58a6ff', '#e5534b', '#3fb950', '#bc8cff', '#f0a020', '#ec6cb9', '#39c5cf']

interface ModelOption {
  value: string
  label: string
}

interface Props {
  open: boolean
  roomId: string
  member: WarRoomMember | null
  onClose: () => void
}

export function MemberEditModal({ open, roomId, member, onClose }: Props): React.JSX.Element {
  const addMember = useWarRoomStore((s) => s.addMember)
  const updateMember = useWarRoomStore((s) => s.updateMember)
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const detectAvailableAgentSdks = useSettingsStore((s) => s.detectAvailableAgentSdks)

  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [stance, setStance] = useState('')
  const [agentSdk, setAgentSdk] = useState<ProviderId>('claude-code')
  const [modelId, setModelId] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)

  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  // Seed form when opened.
  useEffect(() => {
    if (!open) return
    setName(member?.name ?? '')
    setRole(member?.role ?? '')
    setStance(member?.stance ?? '')
    setAgentSdk((member?.agent_sdk as ProviderId) ?? 'claude-code')
    setModelId(member?.model_id ?? '')
    setColor(member?.color ?? COLORS[0])
    setSystemPrompt(member?.system_prompt ?? '')
    setSaving(false)
    if (!availableAgentSdks) void detectAvailableAgentSdks()
  }, [open, member, availableAgentSdks, detectAvailableAgentSdks])

  // Load the model catalog for the selected provider.
  useEffect(() => {
    if (!open) return
    let active = true
    setModelsLoading(true)
    setModels([])
    ;(async () => {
      try {
        const result = unwrapEnvelope(await opencodeApi.listModels({ agentSdk }))
        const providers = result.success ? parseProviders(result.providers) : []
        const opts: ModelOption[] = []
        for (const p of providers) {
          for (const m of p.models) {
            const value = agentSdk === 'opencode' ? `${p.providerID}/${m.id}` : m.id
            const label =
              agentSdk === 'opencode'
                ? `${p.providerName} / ${m.name ?? m.id}`
                : (m.name ?? m.id)
            opts.push({ value, label })
          }
        }
        if (!active) return
        setModels(opts)
        // Keep current selection if still valid, else default to the first model.
        setModelId((prev) =>
          prev && opts.some((o) => o.value === prev) ? prev : (opts[0]?.value ?? '')
        )
      } catch (err) {
        console.error('[WarRoom] listModels failed', err)
        if (active) setModels([])
      } finally {
        if (active) setModelsLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [open, agentSdk])

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        role: role.trim() || null,
        stance: stance.trim() || null,
        agent_sdk: agentSdk,
        model_id: modelId || null,
        color,
        system_prompt: systemPrompt.trim() || null
      }
      if (member) {
        await updateMember(member.id, payload)
      } else {
        await addMember({ ...payload, war_room_id: roomId })
      }
      onClose()
    } catch (err) {
      toast.error(`Failed to save member: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const providerAvailable = (availKey: 'claude' | 'codex' | 'opencode'): boolean =>
    availableAgentSdks ? availableAgentSdks[availKey] : true

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{member ? 'Edit agent' : 'Add agent'}</DialogTitle>
          <DialogDescription>
            A persona that joins the round table. Pick which AI powers it, its model, role and
            instructions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Architect" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Role</label>
              <Input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Systems Architect"
              />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Powered by
              </label>
              <select
                value={agentSdk}
                onChange={(e) => setAgentSdk(e.target.value as ProviderId)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {PROVIDERS.map((p) => {
                  const avail = providerAvailable(p.availKey)
                  return (
                    <option key={p.id} value={p.id} disabled={!avail}>
                      {p.label}
                      {avail ? '' : ' (not installed)'}
                    </option>
                  )
                })}
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Model</label>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                disabled={modelsLoading || models.length === 0}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
              >
                {modelsLoading ? (
                  <option value="">Loading…</option>
                ) : models.length === 0 ? (
                  <option value="">No models available</option>
                ) : (
                  models.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Stance (optional)
            </label>
            <Input
              value={stance}
              onChange={(e) => setStance(e.target.value)}
              placeholder="for / against / neutral"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Color</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full border-2 ${color === c ? 'border-foreground' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                  aria-label={`color ${c}`}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Persona instructions
            </label>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You care about… You should always…"
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {member ? 'Save' : 'Add agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
