import { describe, expect, it } from 'vitest'
import { buildConditionGateConfig } from '@shared/lib/condition-gate'
import type { KanbanTicket } from '../../../../../../main/db/types'
import type { TicketKey } from '@/stores/useKanbanStore'
import {
  buildBoardGraph,
  buildChainGraph,
  deriveNodePhase,
  deriveNodeStatus,
  groupChains,
  layoutChain,
  parseRound
} from '../workflow-graph'

// Mirror of the store's `ticketKey` so test fixtures key consistently with the
// pure module's internal `keyOf` (both encodeURIComponent).
const key = (projectId: string, id: string): TicketKey =>
  `${encodeURIComponent(projectId)}:${encodeURIComponent(id)}`

const PROJECT = 'proj'

function mkTicket(overrides: Partial<KanbanTicket> & { id: string }): KanbanTicket {
  return {
    project_id: PROJECT,
    title: 'Untitled',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    auto_approve_plan: false,
    note: null,
    created_from_session: false,
    auto_approve_review: false,
    ...overrides
  }
}

function depMap(entries: Array<[TicketKey, TicketKey[]]>): Map<TicketKey, Set<TicketKey>> {
  return new Map(entries.map(([dependent, blockers]) => [dependent, new Set(blockers)]))
}

describe('deriveNodePhase', () => {
  it('maps base speckit titles', () => {
    expect(deriveNodePhase('Specify — auth flow')).toBe('specify')
    expect(deriveNodePhase('Clarify the requirements')).toBe('clarify')
    expect(deriveNodePhase('Checklist — 42')).toBe('checklist')
    expect(deriveNodePhase('Plan the work')).toBe('plan')
    expect(deriveNodePhase('Tasks breakdown')).toBe('tasks')
    expect(deriveNodePhase('Analyze the design')).toBe('analyze')
    expect(deriveNodePhase('Implement the feature')).toBe('implement')
  })

  it('prefers compound phases over their substrings', () => {
    expect(deriveNodePhase('Review plan (round 3) — feature')).toBe('review-plan')
    expect(deriveNodePhase('Review (gate, round 3) — feature')).toBe('review')
    expect(deriveNodePhase('Feedback fix — reviewer notes')).toBe('feedback-fix')
    expect(deriveNodePhase('Feedback — reviewer notes')).toBe('feedback')
    expect(deriveNodePhase('Fix (round 2) — feature')).toBe('fix')
  })

  it('tolerates round/run/gate suffixes', () => {
    expect(deriveNodePhase('Review (gate, round 12) — 2611')).toBe('review')
    expect(deriveNodePhase('E2E Execute (run 3)')).toBe('shard')
  })

  it('falls back to generic for non-speckit titles', () => {
    expect(deriveNodePhase('Fix the login button color')).toBe('fix') // has "fix"
    expect(deriveNodePhase('Refactor the API client')).toBe('generic')
    expect(deriveNodePhase('')).toBe('generic')
    expect(deriveNodePhase(null)).toBe('generic')
  })
})

describe('parseRound', () => {
  it('parses (round N)', () => {
    expect(parseRound('Fix (round 3) — x')).toBe(3)
    expect(parseRound('Review (gate, round 12) — x')).toBe(12)
  })
  it('parses (run N)', () => {
    expect(parseRound('E2E Execute (run 5)')).toBe(5)
  })
  it('returns 0 when absent or invalid', () => {
    expect(parseRound('Review — x')).toBe(0)
    expect(parseRound('')).toBe(0)
    expect(parseRound(undefined)).toBe(0)
  })
  it('does not match "round" as a substring of another word (B1 regression)', () => {
    expect(parseRound('Fix the background 5 job')).toBe(0)
    expect(parseRound('Improve turnaround 3')).toBe(0)
    expect(parseRound('surround 9 sound')).toBe(0)
  })
})

describe('deriveNodeStatus', () => {
  it('maps columns directly', () => {
    expect(deriveNodeStatus(mkTicket({ id: 'a', column: 'done' }), [])).toBe('done')
    expect(deriveNodeStatus(mkTicket({ id: 'a', column: 'in_progress' }), [])).toBe('running')
    expect(deriveNodeStatus(mkTicket({ id: 'a', column: 'review' }), [])).toBe('review')
  })
  it('splits todo into blocked vs todo by blocker completion', () => {
    const doneBlocker = mkTicket({ id: 'b1', column: 'done' })
    const openBlocker = mkTicket({ id: 'b2', column: 'in_progress' })
    expect(deriveNodeStatus(mkTicket({ id: 'a', column: 'todo' }), [doneBlocker])).toBe('todo')
    expect(deriveNodeStatus(mkTicket({ id: 'a', column: 'todo' }), [])).toBe('todo')
    expect(deriveNodeStatus(mkTicket({ id: 'a', column: 'todo' }), [doneBlocker, openBlocker])).toBe(
      'blocked'
    )
  })
})

describe('groupChains — worktree union (fix-round regression guard)', () => {
  it('reattaches a dependency-less fix round to its origin chain via shared worktree', () => {
    const kSpec = key(PROJECT, 'spec')
    const kReview = key(PROJECT, 'review')
    const kFix = key(PROJECT, 'fix-r1')
    const tickets = [
      mkTicket({ id: 'spec', worktree_id: 'wt-1', title: 'Specify' }),
      mkTicket({ id: 'review', worktree_id: 'wt-1', title: 'Review (gate)' }),
      // fix round has NO dependsOn back to the chain — only the shared worktree.
      mkTicket({ id: 'fix-r1', worktree_id: 'wt-1', title: 'Fix (round 1)' })
    ]
    const ticketByKey = new Map(tickets.map((t) => [key(PROJECT, t.id), t]))
    // review depends on spec; fix-r1 depends on nothing.
    const deps = depMap([[kReview, [kSpec]]])

    const components = groupChains([kSpec, kReview, kFix], deps, ticketByKey)
    expect(components).toHaveLength(1)
    expect(new Set(components[0])).toEqual(new Set([kSpec, kReview, kFix]))
  })

  it('keeps unrelated chains (distinct worktrees) in separate lanes', () => {
    const a1 = key(PROJECT, 'a1')
    const a2 = key(PROJECT, 'a2')
    const b1 = key(PROJECT, 'b1')
    const tickets = [
      mkTicket({ id: 'a1', worktree_id: 'wt-a' }),
      mkTicket({ id: 'a2', worktree_id: 'wt-a' }),
      mkTicket({ id: 'b1', worktree_id: 'wt-b' })
    ]
    const ticketByKey = new Map(tickets.map((t) => [key(PROJECT, t.id), t]))
    const deps = depMap([[a2, [a1]]])
    const components = groupChains([a1, a2, b1], deps, ticketByKey)
    expect(components).toHaveLength(2)
  })

  it('surfaces a dependency-less, worktree-less ticket as its own singleton lane', () => {
    const solo = key(PROJECT, 'solo')
    const ticketByKey = new Map([[solo, mkTicket({ id: 'solo' })]])
    const components = groupChains([solo], new Map(), ticketByKey)
    expect(components).toEqual([[solo]])
  })
})

describe('layoutChain', () => {
  it('collapses a linear chain to a single vertical spine (constant x)', () => {
    const a = key(PROJECT, 'a')
    const b = key(PROJECT, 'b')
    const c = key(PROJECT, 'c')
    // topo order: a, b, c (b depends on a, c depends on b)
    const deps = depMap([
      [b, [a]],
      [c, [b]]
    ])
    const layout = layoutChain([a, b, c], deps)
    const xa = layout.positions.get(a)!.x
    expect(layout.positions.get(b)!.x).toBe(xa)
    expect(layout.positions.get(c)!.x).toBe(xa)
    // Ranks increase down the spine.
    expect(layout.ranks.get(a)).toBe(0)
    expect(layout.ranks.get(b)).toBe(1)
    expect(layout.ranks.get(c)).toBe(2)
    // y grows with rank.
    expect(layout.positions.get(c)!.y).toBeGreaterThan(layout.positions.get(a)!.y)
  })

  it('spreads a diamond horizontally at the fan-out rank', () => {
    const root = key(PROJECT, 'root')
    const l = key(PROJECT, 'l')
    const r = key(PROJECT, 'r')
    const join = key(PROJECT, 'join')
    // root → {l, r} → join
    const deps = depMap([
      [l, [root]],
      [r, [root]],
      [join, [l, r]]
    ])
    const layout = layoutChain([root, l, r, join], deps)
    expect(layout.ranks.get(root)).toBe(0)
    expect(layout.ranks.get(l)).toBe(1)
    expect(layout.ranks.get(r)).toBe(1)
    expect(layout.ranks.get(join)).toBe(2)
    // The two rank-1 nodes occupy distinct x positions.
    expect(layout.positions.get(l)!.x).not.toBe(layout.positions.get(r)!.x)
  })

  it('terminates without NaN on a cycle', () => {
    const a = key(PROJECT, 'a')
    const b = key(PROJECT, 'b')
    // a ↔ b cycle
    const deps = depMap([
      [a, [b]],
      [b, [a]]
    ])
    const layout = layoutChain([a, b], deps)
    for (const p of layout.positions.values()) {
      expect(Number.isNaN(p.x)).toBe(false)
      expect(Number.isNaN(p.y)).toBe(false)
    }
    expect(Number.isNaN(layout.width)).toBe(false)
    expect(Number.isNaN(layout.height)).toBe(false)
  })
})

describe('buildChainGraph — edges', () => {
  it('draws real edges from blocker (source) → dependent (target)', () => {
    const kSpec = key(PROJECT, 'spec')
    const kImpl = key(PROJECT, 'impl')
    const tickets = [
      mkTicket({ id: 'spec', title: 'Specify', worktree_id: 'wt-1' }),
      mkTicket({ id: 'impl', title: 'Implement', worktree_id: 'wt-1' })
    ]
    const deps = depMap([[kImpl, [kSpec]]])
    const graph = buildChainGraph(kSpec, tickets, deps)
    const edge = graph.edges.find((e) => e.source === kSpec && e.target === kImpl)
    expect(edge).toBeTruthy()
    // Direction is blocker → dependent (top-down flow).
    expect(edge!.source).toBe(kSpec)
    expect(edge!.target).toBe(kImpl)
  })

  it('fabricates a dashed loop edge from the origin review gate to fix-r1', () => {
    const kSpec = key(PROJECT, 'spec')
    const kReview = key(PROJECT, 'review')
    const kFix = key(PROJECT, 'fix-r1')
    const kReviewPlan1 = key(PROJECT, 'rp-r1')
    const kReview1 = key(PROJECT, 'rev-r1')
    const gateCfg = buildConditionGateConfig()
    const tickets = [
      mkTicket({ id: 'spec', title: 'Specify', worktree_id: 'wt-1', column: 'done' }),
      mkTicket({
        id: 'review',
        title: 'Review (gate) — feature',
        worktree_id: 'wt-1',
        column: 'review',
        lifecycle_callbacks: gateCfg
      }),
      // The fix round: no dependsOn back to `review`, only the shared worktree.
      mkTicket({ id: 'fix-r1', title: 'Fix (round 1) — feature', worktree_id: 'wt-1' }),
      mkTicket({ id: 'rp-r1', title: 'Review plan (round 1) — feature', worktree_id: 'wt-1' }),
      mkTicket({
        id: 'rev-r1',
        title: 'Review (gate, round 1) — feature',
        worktree_id: 'wt-1',
        lifecycle_callbacks: gateCfg
      })
    ]
    // Real deps: review→spec, rp-r1→fix-r1, rev-r1→rp-r1.
    const deps = depMap([
      [kReview, [kSpec]],
      [kReviewPlan1, [kFix]],
      [kReview1, [kReviewPlan1]]
    ])
    const graph = buildChainGraph(kSpec, tickets, deps)

    // All five nodes belong to one lane (worktree union).
    const ticketNodeIds = graph.nodes.filter((n) => n.type === 'ticket').map((n) => n.id)
    expect(new Set(ticketNodeIds)).toEqual(
      new Set([kSpec, kReview, kFix, kReviewPlan1, kReview1])
    )

    const loopEdge = graph.edges.find((e) => e.id.startsWith('loop:'))
    expect(loopEdge).toBeTruthy()
    expect(loopEdge!.source).toBe(kReview) // origin gate (round 0)
    expect(loopEdge!.target).toBe(kFix) // fix round 1
    expect((loopEdge!.style as Record<string, unknown>).strokeDasharray).toBeTruthy()
  })
})

describe('buildBoardGraph', () => {
  it('emits a lane-label node per chain and marks running lanes', () => {
    const kSpec = key(PROJECT, 'spec')
    const kImpl = key(PROJECT, 'impl')
    const tickets = [
      mkTicket({ id: 'spec', title: 'Specify', worktree_id: 'wt-1', column: 'done' }),
      mkTicket({
        id: 'impl',
        title: 'Implement',
        worktree_id: 'wt-1',
        column: 'in_progress',
        current_session_id: 'sess-1'
      })
    ]
    const deps = depMap([[kImpl, [kSpec]]])
    const graph = buildBoardGraph(tickets, deps)
    const labels = graph.nodes.filter((n) => n.type === 'laneLabel')
    expect(labels).toHaveLength(1)
    expect((labels[0].data as { running: boolean }).running).toBe(true)
    // The running node is the follow target.
    expect(graph.activeNodeId).toBe(kImpl)
  })

  it('returns an empty graph for no tickets', () => {
    const graph = buildBoardGraph([], new Map())
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
    expect(graph.activeNodeId).toBeNull()
  })
})
