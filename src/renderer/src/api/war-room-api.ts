import { getRendererRpcClient } from './rpc-client'
import {
  WAR_ROOM_EVENT_CHANNEL,
  isWarRoomStreamEvent,
  type WarRoomStreamEvent
} from '@shared/war-room-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type {
  WarRoom,
  WarRoomCreate,
  WarRoomUpdate,
  WarRoomMember,
  WarRoomMemberCreate,
  WarRoomMemberUpdate,
  WarRoomMessage
} from '../../../main/db/types'

export interface WarRoomDetail {
  room: WarRoom
  members: WarRoomMember[]
  messages: WarRoomMessage[]
}

const rpc = () => getRendererRpcClient()

export const warRoomApi = {
  room: {
    create: (data: WarRoomCreate): Promise<WarRoom> =>
      rpc().request<WarRoom>('warRoom.room.create', data),
    get: (id: string): Promise<WarRoom | null> =>
      rpc().request<WarRoom | null>('warRoom.room.get', { id }),
    /** Pass `null` for standalone (project-less) rooms. */
    list: (projectId: string | null): Promise<WarRoom[]> =>
      rpc().request<WarRoom[]>('warRoom.room.list', { projectId }),
    detail: (id: string): Promise<WarRoomDetail | null> =>
      rpc().request<WarRoomDetail | null>('warRoom.room.detail', { id }),
    update: (id: string, data: WarRoomUpdate): Promise<WarRoom | null> =>
      rpc().request<WarRoom | null>('warRoom.room.update', { id, data }),
    delete: (id: string): Promise<boolean> =>
      rpc().request<boolean>('warRoom.room.delete', { id })
  },
  member: {
    add: (data: WarRoomMemberCreate): Promise<WarRoomMember> =>
      rpc().request<WarRoomMember>('warRoom.member.add', data),
    update: (id: string, data: WarRoomMemberUpdate): Promise<WarRoomMember | null> =>
      rpc().request<WarRoomMember | null>('warRoom.member.update', { id, data }),
    remove: (id: string): Promise<boolean> =>
      rpc().request<boolean>('warRoom.member.remove', { id })
  },
  messages: {
    list: (roomId: string): Promise<WarRoomMessage[]> =>
      rpc().request<WarRoomMessage[]>('warRoom.messages.list', { roomId })
  },
  run: {
    start: (roomId: string): Promise<{ started: boolean }> =>
      rpc().request('warRoom.run.start', { roomId }),
    pause: (roomId: string): Promise<{ paused: boolean }> =>
      rpc().request('warRoom.run.pause', { roomId }),
    injectCeo: (roomId: string, content: string): Promise<{ ok: boolean }> =>
      rpc().request('warRoom.run.injectCeo', { roomId, content }),
    achieve: (roomId: string): Promise<{ started: boolean }> =>
      rpc().request('warRoom.run.achieve', { roomId })
  },
  /** Subscribe to live orchestrator events. Returns an unsubscribe fn. */
  onEvent: (callback: (event: WarRoomStreamEvent) => void): (() => void) =>
    rpc().subscribe(WAR_ROOM_EVENT_CHANNEL, (event: ServerEvent) => {
      if (isWarRoomStreamEvent(event.payload)) callback(event.payload)
    })
}
