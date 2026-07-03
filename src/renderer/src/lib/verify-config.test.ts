import { describe, expect, it } from 'vitest'
import {
  resolveVerifyConfig,
  DEFAULT_FROZEN_IDLE_SECONDS,
  MIN_FROZEN_IDLE_MS,
  type VerifyGlobalSettings
} from './verify-config'
import { buildConditionGateConfig } from '@shared/lib/condition-gate'
import type { VerifyOverrides } from '@shared/types/completion'
import type { TicketLifecycleConfig } from '@shared/types/ticket-lifecycle'

// resolveVerifyConfig folds per-ticket overrides over gate-type defaults over the
// global settings. These tests pin that three-level precedence + the frozen-window
// floor — the single source of truth the settle handler and the per-ticket UI share.

type TicketShape = { lifecycle_callbacks: TicketLifecycleConfig | null; verify_overrides: VerifyOverrides | null }

const GATE: TicketLifecycleConfig = buildConditionGateConfig({})

function ticket(
  lifecycle: TicketLifecycleConfig | null,
  overrides: VerifyOverrides | null = null
): TicketShape {
  return { lifecycle_callbacks: lifecycle, verify_overrides: overrides }
}

// "everything on" globals so a resolved `false` can only come from a gate default
// or a per-ticket override, never from an unset global.
const ALL_ON: VerifyGlobalSettings = {
  kanbanStrictVerifySnapshotEnabled: true,
  kanbanStrictVerifyReviewerEnabled: true,
  kanbanStrictVerifyFrozenIdleSeconds: 5
}

describe('resolveVerifyConfig — ticket-type defaults', () => {
  it('normal build ticket: frozen on, LLM reviewer on, no gate loop', () => {
    const r = resolveVerifyConfig(ticket(null), ALL_ON)
    expect(r.isGate).toBe(false)
    expect(r.frozenEnabled).toBe(true)
    expect(r.llmReviewer).toBe(true)
    expect(r.gateLoop).toBe(false)
  })

  it('gate/review ticket: frozen on, LLM reviewer AUTO-OFF, gate loop on (the 2822 fix)', () => {
    const r = resolveVerifyConfig(ticket(GATE), ALL_ON)
    expect(r.isGate).toBe(true)
    expect(r.frozenEnabled).toBe(true)
    expect(r.llmReviewer).toBe(false) // gate prose must not be judged by the Watcher
    expect(r.gateLoop).toBe(true)
  })
})

describe('resolveVerifyConfig — global settings feed non-gate defaults', () => {
  it('snapshot off → frozen off; reviewer off → normal reviewer off', () => {
    const r = resolveVerifyConfig(ticket(null), {
      kanbanStrictVerifySnapshotEnabled: false,
      kanbanStrictVerifyReviewerEnabled: false
    })
    expect(r.frozenEnabled).toBe(false)
    expect(r.llmReviewer).toBe(false)
  })

  it('unset globals fall back to on (snapshot) / on (reviewer)', () => {
    const r = resolveVerifyConfig(ticket(null), {})
    expect(r.frozenEnabled).toBe(true)
    expect(r.llmReviewer).toBe(true)
  })
})

describe('resolveVerifyConfig — per-ticket overrides win over both', () => {
  it('gate ticket can opt the Watcher back ON', () => {
    const r = resolveVerifyConfig(ticket(GATE, { llmReviewer: true }), ALL_ON)
    expect(r.llmReviewer).toBe(true)
  })

  it('gate ticket can disable the gate loop', () => {
    const r = resolveVerifyConfig(ticket(GATE, { gateLoop: false }), ALL_ON)
    expect(r.gateLoop).toBe(false)
  })

  it('normal ticket can force the frozen check off even when the global is on', () => {
    const r = resolveVerifyConfig(ticket(null, { frozenCheck: false }), ALL_ON)
    expect(r.frozenEnabled).toBe(false)
  })

  it('a null override field means "use the default" (not "off")', () => {
    const r = resolveVerifyConfig(
      ticket(GATE, { frozenCheck: null, llmReviewer: null, gateLoop: null }),
      ALL_ON
    )
    expect(r.frozenEnabled).toBe(true)
    expect(r.llmReviewer).toBe(false) // still the gate default
    expect(r.gateLoop).toBe(true)
  })
})

describe('resolveVerifyConfig — frozen idle window', () => {
  it('per-ticket seconds beat the global', () => {
    const r = resolveVerifyConfig(ticket(null, { frozenIdleSeconds: 10 }), ALL_ON)
    expect(r.frozenIdleMs).toBe(10_000)
  })

  it('falls back to the global when no override', () => {
    const r = resolveVerifyConfig(ticket(null), { kanbanStrictVerifyFrozenIdleSeconds: 3 })
    expect(r.frozenIdleMs).toBe(3_000)
  })

  it('falls back to the default (5s) when neither is set', () => {
    const r = resolveVerifyConfig(ticket(null), {})
    expect(r.frozenIdleMs).toBe(DEFAULT_FROZEN_IDLE_SECONDS * 1000)
  })

  it('never drops below the 2s floor (the CLI 1s clock tick must be exceeded)', () => {
    const r = resolveVerifyConfig(ticket(null, { frozenIdleSeconds: 1 }), ALL_ON)
    expect(r.frozenIdleMs).toBe(MIN_FROZEN_IDLE_MS)
  })
})
