import { Effect } from 'effect'
import { z } from 'zod'
import { WAR_ROOM_EVENT_CHANNEL, type WarRoomStreamEvent } from '@shared/war-room-events'
import type {
  WarRoom,
  WarRoomCreate,
  WarRoomUpdate,
  WarRoomMember,
  WarRoomMemberCreate,
  WarRoomMemberUpdate,
  WarRoomMessage
} from '../../../main/db'
import type { RpcContext, RpcHandler } from '../router'

/** Room + roster + transcript, fetched together for the detail view. */
export interface WarRoomDetail {
  room: WarRoom
  members: WarRoomMember[]
  messages: WarRoomMessage[]
}

export interface WarRoomOpsRpcService {
  readonly createRoom: (data: WarRoomCreate) => Effect.Effect<WarRoom, unknown, never>
  readonly getRoom: (id: string) => Effect.Effect<WarRoom | null, unknown, never>
  readonly listRooms: (
    projectId: string | null
  ) => Effect.Effect<WarRoom[], unknown, never>
  readonly getRoomDetail: (id: string) => Effect.Effect<WarRoomDetail | null, unknown, never>
  readonly updateRoom: (
    id: string,
    data: WarRoomUpdate
  ) => Effect.Effect<WarRoom | null, unknown, never>
  readonly deleteRoom: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly addMember: (data: WarRoomMemberCreate) => Effect.Effect<WarRoomMember, unknown, never>
  readonly updateMember: (
    id: string,
    data: WarRoomMemberUpdate
  ) => Effect.Effect<WarRoomMember | null, unknown, never>
  readonly removeMember: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly listMessages: (roomId: string) => Effect.Effect<WarRoomMessage[], unknown, never>
}

export const makeLiveWarRoomOpsRpcService = (): WarRoomOpsRpcService => ({
  createRoom: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createWarRoom(data)
      },
      catch: (cause) => cause
    }),
  getRoom: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getWarRoom(id)
      },
      catch: (cause) => cause
    }),
  listRooms: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getWarRoomsByProject(projectId)
      },
      catch: (cause) => cause
    }),
  getRoomDetail: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        const db = getDatabase()
        const room = db.getWarRoom(id)
        if (!room) return null
        return {
          room,
          members: db.getWarRoomMembers(id),
          messages: db.getWarRoomMessages(id)
        }
      },
      catch: (cause) => cause
    }),
  updateRoom: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateWarRoom(id, data)
      },
      catch: (cause) => cause
    }),
  deleteRoom: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteWarRoom(id)
      },
      catch: (cause) => cause
    }),
  addMember: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createWarRoomMember(data)
      },
      catch: (cause) => cause
    }),
  updateMember: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateWarRoomMember(id, data)
      },
      catch: (cause) => cause
    }),
  removeMember: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteWarRoomMember(id)
      },
      catch: (cause) => cause
    }),
  listMessages: (roomId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getWarRoomMessages(roomId)
      },
      catch: (cause) => cause
    })
})

// ── Zod param schemas ────────────────────────────────────────────────────────

const roomStatusSchema = z.enum([
  'draft',
  'active',
  'paused',
  'awaiting_ceo',
  'concluded',
  'achieved'
])
const orchestrationModeSchema = z.enum(['round_robin'])

const roomCreateSchema = z
  .object({
    id: z.string().optional(),
    project_id: z.string().nullable().optional(),
    title: z.string(),
    topic: z.string().nullable().optional(),
    status: roomStatusSchema.optional(),
    orchestration_mode: orchestrationModeSchema.optional(),
    max_rounds: z.number().int().positive().max(20).optional(),
    seed_ticket_id: z.string().nullable().optional()
  })
  .strict() satisfies z.ZodType<WarRoomCreate>

const roomUpdateSchema = z
  .object({
    title: z.string().optional(),
    topic: z.string().nullable().optional(),
    status: roomStatusSchema.optional(),
    max_rounds: z.number().int().positive().max(20).optional(),
    current_round: z.number().int().min(0).optional(),
    current_turn: z.number().int().min(0).optional(),
    total_tokens: z.number().int().min(0).optional(),
    concluded_at: z.string().nullable().optional()
  })
  .strict()

const roomIdSchema = z.object({ id: z.string() }).strict()
const listRoomsSchema = z.object({ projectId: z.string().nullable() }).strict()
const updateRoomSchema = z.object({ id: z.string(), data: roomUpdateSchema }).strict()

const memberCreateSchema = z
  .object({
    id: z.string().optional(),
    war_room_id: z.string(),
    name: z.string(),
    role: z.string().nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    stance: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    agent_sdk: z.string().nullable().optional(),
    model_id: z.string().nullable().optional(),
    model_variant: z.string().nullable().optional(),
    speaking_order: z.number().int().min(0).optional(),
    is_moderator: z.boolean().optional(),
    is_active: z.boolean().optional()
  })
  .strict() satisfies z.ZodType<WarRoomMemberCreate>

const memberUpdateSchema = z
  .object({
    name: z.string().optional(),
    role: z.string().nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    stance: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    agent_sdk: z.string().nullable().optional(),
    model_id: z.string().nullable().optional(),
    model_variant: z.string().nullable().optional(),
    speaking_order: z.number().int().min(0).optional(),
    is_moderator: z.boolean().optional(),
    is_active: z.boolean().optional()
  })
  .strict()

const updateMemberSchema = z.object({ id: z.string(), data: memberUpdateSchema }).strict()
const memberIdSchema = z.object({ id: z.string() }).strict()
const roomIdParamSchema = z.object({ roomId: z.string() }).strict()
const injectCeoSchema = z.object({ roomId: z.string(), content: z.string() }).strict()

// ── Orchestration bridge ─────────────────────────────────────────────────────

/** Build the emit callback the orchestrator uses to push events to the renderer. */
const makeEmit =
  (context: RpcContext) =>
  (event: WarRoomStreamEvent): void => {
    void Effect.runPromise(
      context.eventBus.publish({ channel: WAR_ROOM_EVENT_CHANNEL, payload: event })
    ).catch(() => undefined)
  }

export const makeWarRoomOpsRpcHandlers = (
  service: WarRoomOpsRpcService = makeLiveWarRoomOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'warRoom.room.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => roomCreateSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createRoom(data)
        })
    ],
    [
      'warRoom.room.get',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => roomIdSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getRoom(id)
        })
    ],
    [
      'warRoom.room.list',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => listRoomsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listRooms(projectId)
        })
    ],
    [
      'warRoom.room.detail',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => roomIdSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getRoomDetail(id)
        })
    ],
    [
      'warRoom.room.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => updateRoomSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateRoom(id, data)
        })
    ],
    [
      'warRoom.room.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => roomIdSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteRoom(id)
        })
    ],
    [
      'warRoom.member.add',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => memberCreateSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.addMember(data)
        })
    ],
    [
      'warRoom.member.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => updateMemberSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateMember(id, data)
        })
    ],
    [
      'warRoom.member.remove',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => memberIdSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeMember(id)
        })
    ],
    [
      'warRoom.messages.list',
      (params) =>
        Effect.gen(function* () {
          const { roomId } = yield* Effect.try({
            try: () => roomIdParamSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listMessages(roomId)
        })
    ],
    [
      'warRoom.run.start',
      (params, context) =>
        Effect.gen(function* () {
          const { roomId } = yield* Effect.try({
            try: () => roomIdParamSchema.parse(params),
            catch: (cause) => cause
          })
          yield* Effect.tryPromise({
            try: async () => {
              const { startWarRoom } = await import(
                '../../../main/services/war-room-orchestrator'
              )
              await startWarRoom(roomId, makeEmit(context))
            },
            catch: (cause) => cause
          })
          return { started: true }
        })
    ],
    [
      'warRoom.run.pause',
      (params, context) =>
        Effect.gen(function* () {
          const { roomId } = yield* Effect.try({
            try: () => roomIdParamSchema.parse(params),
            catch: (cause) => cause
          })
          yield* Effect.tryPromise({
            try: async () => {
              const { pauseWarRoom } = await import(
                '../../../main/services/war-room-orchestrator'
              )
              pauseWarRoom(roomId, makeEmit(context))
            },
            catch: (cause) => cause
          })
          return { paused: true }
        })
    ],
    [
      'warRoom.run.injectCeo',
      (params, context) =>
        Effect.gen(function* () {
          const { roomId, content } = yield* Effect.try({
            try: () => injectCeoSchema.parse(params),
            catch: (cause) => cause
          })
          yield* Effect.tryPromise({
            try: async () => {
              const { injectCeo } = await import('../../../main/services/war-room-orchestrator')
              await injectCeo(roomId, content, makeEmit(context))
            },
            catch: (cause) => cause
          })
          return { ok: true }
        })
    ],
    [
      'warRoom.run.achieve',
      (params, context) =>
        Effect.gen(function* () {
          const { roomId } = yield* Effect.try({
            try: () => roomIdParamSchema.parse(params),
            catch: (cause) => cause
          })
          yield* Effect.tryPromise({
            try: async () => {
              const { achieveWarRoom } = await import(
                '../../../main/services/war-room-orchestrator'
              )
              // Fire-and-forget: synthesis can take several seconds; the renderer
              // learns the result from the 'concluded' event, not this response.
              void achieveWarRoom(roomId, makeEmit(context)).catch(() => undefined)
            },
            catch: (cause) => cause
          })
          return { started: true }
        })
    ]
  ])
