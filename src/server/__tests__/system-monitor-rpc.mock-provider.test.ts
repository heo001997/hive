import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { MonitorSnapshot } from '../../shared/system-monitor-events'
import { makeEventBus } from '../events/event-bus'
import type { SystemMonitorOpsRpcService } from '../rpc/domains/system-monitor-ops'
import { makeRpcRouter } from '../rpc/router'

const snapshot: MonitorSnapshot = {
  timestamp: '2026-06-28T00:00:00.000Z',
  host: { cpuCount: 8, cpuPct: 23.4, loadAvg1: 1.2, memTotal: 16e9, memFree: 8e9, memAvailable: 11e9 },
  app: { cpuPct: 12.5, rssTotal: 4e9, procCount: 3 },
  processes: [],
  main: null,
  platform: 'darwin',
  supported: true
}

describe('system monitor ops RPC mocked provider', () => {
  it('routes systemMonitorOps.getSnapshot to the injected provider service', async () => {
    const getSnapshot = vi.fn(() => Effect.succeed(snapshot))
    const service = { getSnapshot } as unknown as SystemMonitorOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemMonitorOps: service })

    const response = await Effect.runPromise(
      router.handle({ id: 'sm-snapshot-1', method: 'systemMonitorOps.getSnapshot', params: {} })
    )

    expect(getSnapshot).toHaveBeenCalledWith()
    expect(response).toEqual({ id: 'sm-snapshot-1', ok: true, value: snapshot })
  })

  it('routes systemMonitorOps.setActive after validating its params', async () => {
    const setActive = vi.fn(() => Effect.void)
    const service = { setActive } as unknown as SystemMonitorOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemMonitorOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'sm-active-1',
        method: 'systemMonitorOps.setActive',
        params: { active: true }
      })
    )

    expect(setActive).toHaveBeenCalledWith(true)
    expect(response).toEqual({ id: 'sm-active-1', ok: true, value: undefined })
  })

  it('rejects systemMonitorOps.setActive with invalid params', async () => {
    const setActive = vi.fn(() => Effect.void)
    const service = { setActive } as unknown as SystemMonitorOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemMonitorOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'sm-active-invalid',
        method: 'systemMonitorOps.setActive',
        params: { active: 'yes' }
      })
    )

    expect(setActive).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'sm-active-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemMonitorOps.killProcess, defaulting group to false', async () => {
    const killProcess = vi.fn(() => Effect.void)
    const service = { killProcess } as unknown as SystemMonitorOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemMonitorOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'sm-kill-1',
        method: 'systemMonitorOps.killProcess',
        params: { pid: 1234 }
      })
    )

    expect(killProcess).toHaveBeenCalledWith(1234, false)
    expect(response).toEqual({ id: 'sm-kill-1', ok: true, value: undefined })
  })

  it('passes the group flag through to systemMonitorOps.killProcess', async () => {
    const killProcess = vi.fn(() => Effect.void)
    const service = { killProcess } as unknown as SystemMonitorOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemMonitorOps: service })

    await Effect.runPromise(
      router.handle({
        id: 'sm-kill-group',
        method: 'systemMonitorOps.killProcess',
        params: { pid: 1234, group: true }
      })
    )

    expect(killProcess).toHaveBeenCalledWith(1234, true)
  })

  it('rejects systemMonitorOps.killProcess with a non-positive pid', async () => {
    const killProcess = vi.fn(() => Effect.void)
    const service = { killProcess } as unknown as SystemMonitorOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemMonitorOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'sm-kill-invalid',
        method: 'systemMonitorOps.killProcess',
        params: { pid: -5 }
      })
    )

    expect(killProcess).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'sm-kill-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
