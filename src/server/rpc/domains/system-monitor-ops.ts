import { Effect } from 'effect'
import { z } from 'zod'
import { systemMonitor } from '../../../main/services/system-monitor'
import type { MonitorAlert, MonitorSnapshot } from '../../../shared/system-monitor-events'
import type { RpcHandler } from '../router'

export interface SystemMonitorOpsRpcService {
  readonly getSnapshot: () => Effect.Effect<MonitorSnapshot, unknown, never>
  readonly getHistory: () => Effect.Effect<MonitorSnapshot[], unknown, never>
  readonly getAlerts: () => Effect.Effect<MonitorAlert[], unknown, never>
  readonly setActive: (active: boolean) => Effect.Effect<void, unknown, never>
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void, unknown, never>
  readonly killProcess: (pid: number, group: boolean) => Effect.Effect<void, unknown, never>
  readonly cleanupOrphans: () => Effect.Effect<number, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const activeParamsSchema = z.object({ active: z.boolean() }).strict()
const enabledParamsSchema = z.object({ enabled: z.boolean() }).strict()
const killParamsSchema = z
  .object({ pid: z.number().int().positive(), group: z.boolean().optional() })
  .strict()

export const makeLiveSystemMonitorOpsRpcService = (): SystemMonitorOpsRpcService => ({
  getSnapshot: () => Effect.try({ try: () => systemMonitor.getSnapshot(), catch: (cause) => cause }),
  getHistory: () => Effect.try({ try: () => systemMonitor.getHistory(), catch: (cause) => cause }),
  getAlerts: () => Effect.try({ try: () => systemMonitor.getAlerts(), catch: (cause) => cause }),
  setActive: (active) =>
    Effect.try({ try: () => systemMonitor.setActive(active), catch: (cause) => cause }),
  setEnabled: (enabled) =>
    Effect.try({ try: () => systemMonitor.setEnabled(enabled), catch: (cause) => cause }),
  killProcess: (pid, group) =>
    Effect.try({ try: () => systemMonitor.killProcess(pid, group), catch: (cause) => cause }),
  cleanupOrphans: () =>
    Effect.tryPromise({ try: () => systemMonitor.cleanupOrphans(), catch: (cause) => cause })
})

export const makeSystemMonitorOpsRpcHandlers = (
  service: SystemMonitorOpsRpcService = makeLiveSystemMonitorOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'systemMonitorOps.getSnapshot',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({ try: () => emptyParamsSchema.parse(params), catch: (cause) => cause })
          return yield* service.getSnapshot()
        })
    ],
    [
      'systemMonitorOps.getHistory',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({ try: () => emptyParamsSchema.parse(params), catch: (cause) => cause })
          return yield* service.getHistory()
        })
    ],
    [
      'systemMonitorOps.getAlerts',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({ try: () => emptyParamsSchema.parse(params), catch: (cause) => cause })
          return yield* service.getAlerts()
        })
    ],
    [
      'systemMonitorOps.setActive',
      (params) =>
        Effect.gen(function* () {
          const { active } = yield* Effect.try({
            try: () => activeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setActive(active)
        })
    ],
    [
      'systemMonitorOps.setEnabled',
      (params) =>
        Effect.gen(function* () {
          const { enabled } = yield* Effect.try({
            try: () => enabledParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setEnabled(enabled)
        })
    ],
    [
      'systemMonitorOps.killProcess',
      (params) =>
        Effect.gen(function* () {
          const { pid, group } = yield* Effect.try({
            try: () => killParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.killProcess(pid, group ?? false)
        })
    ],
    [
      'systemMonitorOps.cleanupOrphans',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({ try: () => emptyParamsSchema.parse(params), catch: (cause) => cause })
          return yield* service.cleanupOrphans()
        })
    ]
  ])
