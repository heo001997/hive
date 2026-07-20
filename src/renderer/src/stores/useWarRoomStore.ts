import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { warRoomApi, type WarRoomDetail } from '@/api/war-room-api'
import type { WarRoomStreamEvent } from '@shared/war-room-events'
import type {
  WarRoom,
  WarRoomMessage,
  WarRoomStatus,
  WarRoomOutcome,
  WarRoomMemberCreate,
  WarRoomMemberUpdate
} from '../../../main/db/types'

/**
 * Default roster seeded into a new room. Always includes a mandatory Skeptic —
 * the cheapest defense against agents sycophantically agreeing on nothing.
 */
export const DEFAULT_ROSTER: Array<Omit<WarRoomMemberCreate, 'war_room_id'>> = [
  {
    name: 'Architect',
    role: 'Systems Architect',
    color: '#58a6ff',
    agent_sdk: 'claude-code',
    model_id: 'sonnet',
    speaking_order: 0,
    system_prompt:
      'You care about system design, long-term maintainability, and tradeoffs. Ground your claims in concrete architecture and call out coupling, complexity, and failure modes.'
  },
  {
    name: 'Skeptic',
    role: "Devil's Advocate",
    color: '#e5534b',
    agent_sdk: 'claude-code',
    model_id: 'sonnet',
    stance: 'against',
    speaking_order: 1,
    system_prompt:
      'Your job is to find flaws, risks, and unstated assumptions. You MUST push back on weak reasoning and challenge the group. Never agree just to be agreeable.'
  },
  {
    name: 'Product',
    role: 'Product Lead',
    color: '#3fb950',
    agent_sdk: 'claude-code',
    model_id: 'sonnet',
    speaking_order: 2,
    system_prompt:
      'You represent user value, scope, and shipping. Keep the discussion tied to what actually helps users and what is realistic to deliver.'
  }
]

interface CreateRoomInput {
  projectId: string | null
  title: string
  topic: string
  maxRounds?: number
  seedDefaults?: boolean
  seedTicketId?: string | null
}

interface WarRoomState {
  /** Top-level surface flag (persisted), toggled from the Header. */
  isWarRoomViewActive: boolean
  rooms: WarRoom[]
  /** Which project scope the `rooms` list was loaded for (`null` = standalone). */
  roomsLoadedFor: string | null | undefined
  activeRoomId: string | null
  detail: WarRoomDetail | null
  isLoading: boolean
  isDetailLoading: boolean
  /** Transient run state driven by orchestrator events. */
  thinkingMemberId: string | null
  thinkingMemberName: string | null
  ceoQuestion: string | null
  ceoAskedBy: string | null
  lastError: string | null

  toggleWarRoomView: () => void
  setWarRoomViewActive: (active: boolean) => void
  loadRooms: (projectId: string | null) => Promise<void>
  createRoom: (input: CreateRoomInput) => Promise<WarRoom>
  updateRoom: (id: string, data: { title?: string; topic?: string; max_rounds?: number }) => Promise<void>
  deleteRoom: (id: string) => Promise<void>
  /** Open the surface and start a room seeded from a kanban ticket. */
  openRoomFromTicket: (ticket: {
    id: string
    project_id: string
    title: string
    description: string | null
  }) => Promise<void>
  openRoom: (id: string) => Promise<void>
  closeRoom: () => void
  reloadDetail: () => Promise<void>
  addMember: (data: WarRoomMemberCreate) => Promise<void>
  updateMember: (id: string, data: WarRoomMemberUpdate) => Promise<void>
  removeMember: (id: string) => Promise<void>
  start: () => Promise<void>
  pause: () => Promise<void>
  injectCeo: (content: string) => Promise<void>
  achieve: () => Promise<void>
  ensureSubscription: () => void
  applyEvent: (event: WarRoomStreamEvent) => void
}

let subscribed = false

export const useWarRoomStore = create<WarRoomState>()(
  persist(
    (set, get) => ({
      isWarRoomViewActive: false,
      rooms: [],
      roomsLoadedFor: undefined,
      activeRoomId: null,
      detail: null,
      isLoading: false,
      isDetailLoading: false,
      thinkingMemberId: null,
      thinkingMemberName: null,
      ceoQuestion: null,
      ceoAskedBy: null,
      lastError: null,

      toggleWarRoomView: () => set((s) => ({ isWarRoomViewActive: !s.isWarRoomViewActive })),
      setWarRoomViewActive: (active) => set({ isWarRoomViewActive: active }),

      loadRooms: async (projectId) => {
        set({ isLoading: true })
        try {
          const rooms = await warRoomApi.room.list(projectId)
          set({ rooms, roomsLoadedFor: projectId, isLoading: false })
        } catch (err) {
          console.error('[WarRoom] loadRooms failed', err)
          set({ isLoading: false })
        }
      },

      createRoom: async (input) => {
        const room = await warRoomApi.room.create({
          project_id: input.projectId,
          title: input.title,
          topic: input.topic,
          max_rounds: input.maxRounds ?? 3,
          seed_ticket_id: input.seedTicketId ?? null
        })
        if (input.seedDefaults !== false) {
          for (const persona of DEFAULT_ROSTER) {
            await warRoomApi.member.add({ ...persona, war_room_id: room.id })
          }
        }
        set((s) => ({ rooms: [room, ...s.rooms] }))
        return room
      },

      updateRoom: async (id, data) => {
        const updated = await warRoomApi.room.update(id, data)
        if (!updated) return
        set((s) => ({
          rooms: s.rooms.map((r) => (r.id === id ? updated : r)),
          detail: s.detail?.room.id === id ? { ...s.detail, room: updated } : s.detail
        }))
      },

      deleteRoom: async (id) => {
        await warRoomApi.room.delete(id)
        set((s) => ({
          rooms: s.rooms.filter((r) => r.id !== id),
          activeRoomId: s.activeRoomId === id ? null : s.activeRoomId,
          detail: s.detail?.room.id === id ? null : s.detail
        }))
      },

      openRoomFromTicket: async (ticket) => {
        const room = await get().createRoom({
          projectId: ticket.project_id,
          title: `Discuss: ${ticket.title}`,
          topic: [ticket.title, ticket.description ?? ''].filter(Boolean).join('\n\n'),
          seedTicketId: ticket.id
        })
        set({ isWarRoomViewActive: true })
        await get().openRoom(room.id)
      },

      openRoom: async (id) => {
        get().ensureSubscription()
        set({
          activeRoomId: id,
          isDetailLoading: true,
          detail: null,
          thinkingMemberId: null,
          ceoQuestion: null,
          ceoAskedBy: null,
          lastError: null
        })
        try {
          const detail = await warRoomApi.room.detail(id)
          // Re-derive a pending escalation from the transcript so the "needs your
          // call" banner survives an app reload (ceoQuestion is transient state).
          let ceoQuestion: string | null = null
          let ceoAskedBy: string | null = null
          if (detail && detail.room.status === 'awaiting_ceo') {
            const last = [...detail.messages].reverse().find((m) => m.needs_ceo)
            if (last) {
              const line = last.content
                .split('\n')
                .map((l) => l.trim())
                .find((l) => l.toUpperCase().startsWith('@CEO:'))
              ceoQuestion = line ? line.slice('@CEO:'.length).trim() : 'Needs your input.'
              ceoAskedBy = detail.members.find((mm) => mm.id === last.member_id)?.name ?? 'An agent'
            }
          }
          set({ detail, isDetailLoading: false, ceoQuestion, ceoAskedBy })
        } catch (err) {
          console.error('[WarRoom] openRoom failed', err)
          set({ isDetailLoading: false })
        }
      },

      closeRoom: () =>
        set({
          activeRoomId: null,
          detail: null,
          thinkingMemberId: null,
          thinkingMemberName: null,
          ceoQuestion: null,
          ceoAskedBy: null,
          lastError: null
        }),

      reloadDetail: async () => {
        const id = get().activeRoomId
        if (!id) return
        const detail = await warRoomApi.room.detail(id)
        set({ detail })
      },

      addMember: async (data) => {
        await warRoomApi.member.add(data)
        await get().reloadDetail()
      },

      updateMember: async (id, data) => {
        await warRoomApi.member.update(id, data)
        await get().reloadDetail()
      },

      removeMember: async (id) => {
        await warRoomApi.member.remove(id)
        await get().reloadDetail()
      },

      start: async () => {
        const id = get().activeRoomId
        if (!id) return
        set({ lastError: null })
        await warRoomApi.run.start(id)
      },

      pause: async () => {
        const id = get().activeRoomId
        if (!id) return
        await warRoomApi.run.pause(id)
      },

      injectCeo: async (content) => {
        const id = get().activeRoomId
        if (!id) return
        // Empty content is allowed — it means "continue". Clear any pending
        // escalation prompt and let the server resume the discussion.
        set({ ceoQuestion: null })
        await warRoomApi.run.injectCeo(id, content)
      },

      achieve: async () => {
        const id = get().activeRoomId
        if (!id) return
        await warRoomApi.run.achieve(id)
      },

      ensureSubscription: () => {
        if (subscribed) return
        subscribed = true
        warRoomApi.onEvent((event) => get().applyEvent(event))
      },

      applyEvent: (event) =>
        set((state) => {
          // Keep the room list's status/round fresh even when the room is closed.
          const rooms = state.rooms.map((r) =>
            r.id === event.roomId && (event.type === 'status' || event.type === 'concluded')
              ? {
                  ...r,
                  status: (event.type === 'concluded'
                    ? 'concluded'
                    : event.status) as WarRoomStatus,
                  ...(event.type === 'status' ? { current_round: event.currentRound } : {}),
                  ...(event.type === 'concluded' ? { outcome: event.outcome as WarRoomOutcome } : {})
                }
              : r
          )

          if (!state.detail || state.detail.room.id !== event.roomId) {
            return { rooms }
          }
          const detail = state.detail

          switch (event.type) {
            case 'message': {
              const exists = detail.messages.some((m) => m.id === event.message.id)
              const messages = exists
                ? detail.messages
                : [...detail.messages, event.message as WarRoomMessage]
              return { rooms, detail: { ...detail, messages }, thinkingMemberId: null }
            }
            case 'thinking':
              return {
                rooms,
                thinkingMemberId: event.memberId,
                thinkingMemberName: event.memberName,
                lastError: null
              }
            case 'status':
              return {
                rooms,
                detail: {
                  ...detail,
                  room: {
                    ...detail.room,
                    status: event.status as WarRoomStatus,
                    current_round: event.currentRound,
                    total_tokens: event.totalTokens
                  }
                },
                ...(event.status !== 'awaiting_ceo' ? { ceoQuestion: null } : {})
              }
            case 'awaiting_ceo':
              return {
                rooms,
                ceoQuestion: event.question,
                ceoAskedBy: event.memberName,
                thinkingMemberId: null
              }
            case 'concluded':
              return {
                rooms,
                detail: {
                  ...detail,
                  room: {
                    ...detail.room,
                    status: 'concluded' as WarRoomStatus,
                    outcome: event.outcome as WarRoomOutcome
                  }
                },
                thinkingMemberId: null,
                ceoQuestion: null
              }
            case 'error':
              return { rooms, lastError: event.error, thinkingMemberId: null }
            default:
              return { rooms }
          }
        })
    }),
    {
      name: 'hive-war-room',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ isWarRoomViewActive: state.isWarRoomViewActive })
    }
  )
)
