/**
 * Pure core for the workflow DAG visualization. NO React, NO store, NO
 * `@xyflow/react` runtime import (only its `Node`/`Edge` *types*, which erase at
 * compile) — so every function here is deterministic and unit-testable in the
 * jsdom vitest runtime that lacks the native/DB deps the store transitively pulls.
 *
 * The renderer layer (`useBoardGraph` / `useChainGraph` + `WorkflowGraph`) feeds
 * these builders the store's `tickets` + `dependencyMap` and renders the result.
 */
import type { Edge, Node } from '@xyflow/react'
import type { TicketKey, TicketRef } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../../main/db/types'
import type { ConditionGateVerdictKind } from '@shared/types/completion'
import { isConditionGate, isShardGate } from '@shared/lib/condition-gate'
import { getChainExecutionOrder } from '@/lib/chain-utils'

// ── Types ────────────────────────────────────────────────────────────────

/** Speckit phase a node maps to (title-derived). Non-speckit → `generic`. */
export type WorkflowPhase =
  | 'specify'
  | 'clarify'
  | 'checklist'
  | 'plan'
  | 'tasks'
  | 'analyze'
  | 'implement'
  | 'review-plan'
  | 'review'
  | 'fix'
  | 'feedback'
  | 'feedback-fix'
  | 'shard'
  | 'generic'

/** Live status driving a node's base color. Derived from the optimistic `column`. */
export type WorkflowStatus = 'todo' | 'blocked' | 'running' | 'review' | 'done'

export interface WorkflowNodeData {
  ticketKey: TicketKey
  ref: TicketRef
  title: string
  phase: WorkflowPhase
  status: WorkflowStatus
  /** True when the ticket's lifecycle marks it a condition gate (review gate frame). */
  isGate: boolean
  /** True for the shard-gate variant (auto-e2e loop). */
  isShardGate: boolean
  /** Last recorded gate verdict, if any (drives the verdict badge). */
  gateVerdict: ConditionGateVerdictKind | null
  /** Fix-loop / shard-run round parsed from the title (0 = base). */
  round: number
  /** Pulse animation flag (running + a live session). */
  pulse: boolean
  prNumber: number | null
  prUrl: string | null
  /** True when this is the auto-follow target (deepest running node). */
  isActive: boolean
  // react-flow requires node data to be assignable to Record<string, unknown>.
  [key: string]: unknown
}

export type WorkflowNode = Node<WorkflowNodeData>
export type WorkflowEdge = Edge

/** Data for the non-interactive board lane-label node. */
export interface LaneLabelData {
  title: string
  running: boolean
  [key: string]: unknown
}

export interface WorkflowGraphResult {
  nodes: Node[]
  edges: Edge[]
  /** Node id (= ticketKey) to auto-center on when Follow is on; null = none. */
  activeNodeId: string | null
}

export interface ChainGraphResult extends WorkflowGraphResult {
  /** The lane's derived chain-parent key (earliest-created member). */
  rootKey: TicketKey | null
}

// ── Layout constants ───────────────────────────────────────────────────────

export const NODE_W = 240
export const NODE_H = 96
export const ROW_GAP = 150
export const COL_GAP = 280
export const LANE_GAP = 140

// ── Key helper (mirror of `ticketKey` in useKanbanStore) ─────────────────────
// Kept local so this pure module never imports the store's runtime. MUST stay in
// sync with `ticketKey()` — the `dependencyMap` keys are produced by that function.
function keyOf(t: Pick<KanbanTicket, 'project_id' | 'id'>): TicketKey {
  return `${encodeURIComponent(t.project_id)}:${encodeURIComponent(t.id)}`
}

// ── Phase / status / round derivation ────────────────────────────────────────

// Ordered longest-match-first so compound phases win over their substrings
// (`review plan` before `review`/`plan`; `feedback fix` before `feedback`/`fix`).
const PHASE_MATCHERS: Array<[WorkflowPhase, RegExp]> = [
  ['feedback-fix', /feedback[-\s]*fix/i],
  ['feedback', /feedback/i],
  ['review-plan', /review[-\s]*plan/i],
  ['review', /\breview\b/i],
  ['fix', /\bfix\b/i],
  ['specify', /\bspecif(?:y|ication)\b/i],
  ['clarify', /\bclarif(?:y|ication|ications)\b/i],
  ['checklist', /\bchecklist\b/i],
  ['analyze', /\b(?:analy[sz]e|analysis)\b/i],
  ['implement', /\bimplement(?:ation)?\b/i],
  ['tasks', /\btasks?\b/i],
  ['plan', /\bplan\b/i],
  ['shard', /\b(?:shard|e2e)\b/i]
]

/**
 * Derive a node's speckit phase from its title (case-insensitive, tolerant of
 * `— label`, `(round N)`, `(gate…)`, `(run N)` suffixes). `draftKey` is not
 * persisted on the ticket, so the title is the only available signal. No keyword
 * match → `generic`.
 */
export function deriveNodePhase(title: string | null | undefined): WorkflowPhase {
  const t = title ?? ''
  for (const [phase, re] of PHASE_MATCHERS) {
    if (re.test(t)) return phase
  }
  return 'generic'
}

/**
 * Fix-loop round / shard-run number parsed from the title (`(round N)` or
 * `(run N)`). 0 when neither is present (a base/first ticket).
 */
export function parseRound(title: string | null | undefined): number {
  const t = title ?? ''
  const m = /\bround\s+(\d+)/i.exec(t) ?? /\(\s*run\s+(\d+)\s*\)/i.exec(t)
  if (!m) return 0
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Derive the base status (node color) from the optimistic board `column` — that's
 * what mutates live as a chain runs. `todo` splits into `blocked` (a blocker not
 * yet Done) vs `todo` (all blockers Done / none). Gate verdict + `lifecycle_state`
 * only refine the gate badge, never this base status.
 */
export function deriveNodeStatus(ticket: KanbanTicket, blockers: KanbanTicket[]): WorkflowStatus {
  switch (ticket.column) {
    case 'done':
      return 'done'
    case 'in_progress':
      return 'running'
    case 'review':
      return 'review'
    default: {
      // `todo`: blocked when any *resolved* blocker hasn't reached Done.
      const blocked = blockers.some((b) => b.column !== 'done')
      return blocked ? 'blocked' : 'todo'
    }
  }
}

// ── Grouping (connected components + worktree union) ──────────────────────────

/**
 * Group ticket keys into lanes = dependency-connected components UNIONED across a
 * shared non-null `worktree_id`. The worktree union is load-bearing: fix-loop
 * rounds (`fix-r{N}` …) are created with NO `dependsOn` back to the origin chain
 * (see `buildFixRoundBatch`), so the ONLY thing tying them to their parent chain
 * is the shared worktree. Without this union each fix round would render as its own
 * orphan lane. Undirected adjacency is built ONCE; O(N+E).
 */
export function groupChains(
  ticketKeys: TicketKey[],
  dependencyMap: Map<TicketKey, Set<TicketKey>>,
  ticketByKey: Map<TicketKey, KanbanTicket>
): TicketKey[][] {
  const keySet = new Set(ticketKeys)
  const adjacency = new Map<TicketKey, Set<TicketKey>>()
  const ensure = (k: TicketKey): Set<TicketKey> => {
    let s = adjacency.get(k)
    if (!s) {
      s = new Set<TicketKey>()
      adjacency.set(k, s)
    }
    return s
  }
  // Seed every key so isolated (dependency-less) tickets still surface as a lane.
  for (const k of ticketKeys) ensure(k)
  const link = (a: TicketKey, b: TicketKey): void => {
    if (a === b) return
    ensure(a).add(b)
    ensure(b).add(a)
  }

  // Dependency edges (undirected), restricted to the given key set.
  for (const [dependent, blockers] of dependencyMap) {
    if (!keySet.has(dependent)) continue
    for (const blocker of blockers) {
      if (keySet.has(blocker)) link(dependent, blocker)
    }
  }

  // Worktree union: link every key that shares a non-null worktree_id.
  const byWorktree = new Map<string, TicketKey[]>()
  for (const k of ticketKeys) {
    const wt = ticketByKey.get(k)?.worktree_id
    if (!wt) continue
    const arr = byWorktree.get(wt)
    if (arr) arr.push(k)
    else byWorktree.set(wt, [k])
  }
  for (const arr of byWorktree.values()) {
    for (let i = 1; i < arr.length; i++) link(arr[0], arr[i])
  }

  // Connected components via BFS.
  const seen = new Set<TicketKey>()
  const components: TicketKey[][] = []
  for (const start of ticketKeys) {
    if (seen.has(start)) continue
    const comp: TicketKey[] = []
    const queue: TicketKey[] = [start]
    seen.add(start)
    while (queue.length > 0) {
      const cur = queue.shift() as TicketKey
      comp.push(cur)
      for (const nb of adjacency.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          queue.push(nb)
        }
      }
    }
    components.push(comp)
  }
  return components
}

// ── Layout (hand-rolled longest-path layered layout, no dagre) ────────────────

export interface ChainLayout {
  positions: Map<TicketKey, { x: number; y: number }>
  ranks: Map<TicketKey, number>
  width: number
  height: number
}

/**
 * Layer `orderedKeys` (already topo-ordered, blockers-first) into a top-down DAG.
 *   1. `rank[key] = max(rank[blocker]) + 1` (0 when no in-component blockers). A
 *      blocker with no rank yet — a cycle back-edge — contributes `-1`, so the
 *      layout stays finite and NaN-free on cyclic input.
 *   2. Within each rank, order by the barycenter of blockers' x (crossing
 *      reduction); rank 0 keeps topo order. `x` is centered on `laneCenterX`.
 * A linear chain collapses to one vertical spine; gate/fix branches & diamonds
 * spread horizontally.
 */
export function layoutChain(
  orderedKeys: TicketKey[],
  dependencyMap: Map<TicketKey, Set<TicketKey>>,
  laneCenterX = 0
): ChainLayout {
  const componentSet = new Set(orderedKeys)
  const blockersOf = (key: TicketKey): TicketKey[] =>
    [...(dependencyMap.get(key) ?? [])].filter((b) => componentSet.has(b))

  // (1) ranks
  const ranks = new Map<TicketKey, number>()
  for (const key of orderedKeys) {
    const blockers = blockersOf(key)
    if (blockers.length === 0) {
      ranks.set(key, 0)
      continue
    }
    let max = -1
    for (const b of blockers) {
      const r = ranks.get(b) ?? -1 // cycle back-edge guard
      if (r > max) max = r
    }
    ranks.set(key, max + 1)
  }

  // group by rank, preserving topo order within each rank
  const byRank = new Map<number, TicketKey[]>()
  for (const key of orderedKeys) {
    const r = ranks.get(key) ?? 0
    const arr = byRank.get(r)
    if (arr) arr.push(key)
    else byRank.set(r, [key])
  }

  // (2) x by barycenter (lower ranks positioned first so blockers' x is known)
  const positions = new Map<TicketKey, { x: number; y: number }>()
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b)
  for (const r of sortedRanks) {
    let keys = byRank.get(r) as TicketKey[]
    if (r > 0) {
      const bary = (key: TicketKey): number => {
        const blockers = blockersOf(key)
        const xs = blockers
          .map((b) => positions.get(b)?.x)
          .filter((x): x is number => typeof x === 'number')
        if (xs.length === 0) return laneCenterX
        return xs.reduce((s, x) => s + x, 0) / xs.length
      }
      keys = keys
        .map((key, i) => ({ key, i, b: bary(key) }))
        .sort((p, q) => p.b - q.b || p.i - q.i)
        .map((p) => p.key)
    }
    const n = keys.length
    keys.forEach((key, i) => {
      positions.set(key, {
        x: laneCenterX + (i - (n - 1) / 2) * COL_GAP,
        y: r * ROW_GAP
      })
    })
  }

  // lane bounds
  let minX = Infinity
  let maxX = -Infinity
  let maxRank = 0
  for (const key of orderedKeys) {
    const p = positions.get(key)
    if (!p) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    const r = ranks.get(key) ?? 0
    if (r > maxRank) maxRank = r
  }
  if (!Number.isFinite(minX)) {
    minX = laneCenterX
    maxX = laneCenterX
  }
  return {
    positions,
    ranks,
    width: maxX - minX + NODE_W,
    height: maxRank * ROW_GAP + NODE_H
  }
}

// ── Graph assembly ────────────────────────────────────────────────────────

/**
 * Augment a dependency map with a fabricated edge from each fix round's origin
 * review gate → the `fix-r{N}` node (`fix` depends-on the gate). This does two
 * things: it lets `getChainExecutionOrder` reach the worktree-union'd fix rounds
 * (so they get a topo rank *below* the gate), AND it drives the dashed loop edge
 * drawn in {@link buildLaneEdges}. Returns the fabricated `gate→fix` pairs so the
 * edge builder can render them dashed.
 */
function fabricateFixLoopEdges(
  componentKeys: TicketKey[],
  ticketByKey: Map<TicketKey, KanbanTicket>,
  realDepMap: Map<TicketKey, Set<TicketKey>>
): {
  augmented: Map<TicketKey, Set<TicketKey>>
  loopPairs: Array<{ gate: TicketKey; fix: TicketKey }>
} {
  const augmented = new Map<TicketKey, Set<TicketKey>>()
  const componentSet = new Set(componentKeys)
  for (const key of componentKeys) {
    const blockers = realDepMap.get(key)
    augmented.set(key, new Set([...(blockers ?? [])].filter((b) => componentSet.has(b))))
  }

  // Index review-gate nodes by their round so a fix round can find its origin.
  const gateByRound = new Map<number, TicketKey>()
  for (const key of componentKeys) {
    const t = ticketByKey.get(key)
    if (!t) continue
    if (deriveNodePhase(t.title) === 'review' && isConditionGate(t.lifecycle_callbacks)) {
      const round = parseRound(t.title)
      if (!gateByRound.has(round)) gateByRound.set(round, key)
    }
  }

  const loopPairs: Array<{ gate: TicketKey; fix: TicketKey }> = []
  for (const key of componentKeys) {
    const t = ticketByKey.get(key)
    if (!t) continue
    if (deriveNodePhase(t.title) !== 'fix') continue
    const round = parseRound(t.title)
    if (round < 1) continue
    const gate = gateByRound.get(round - 1)
    if (!gate || gate === key) continue
    augmented.get(key)?.add(gate)
    loopPairs.push({ gate, fix: key })
  }
  return { augmented, loopPairs }
}

/** Pick a lane's chain-parent: the earliest-created member (stable, tie by key). */
function laneRootKey(componentKeys: TicketKey[], ticketByKey: Map<TicketKey, KanbanTicket>): TicketKey {
  let root = componentKeys[0]
  let best = ticketByKey.get(root)?.created_at ?? ''
  for (const key of componentKeys) {
    const created = ticketByKey.get(key)?.created_at ?? ''
    if (created < best || (created === best && key < root)) {
      best = created
      root = key
    }
  }
  return root
}

/**
 * Topo-order a lane over the fabricated-augmented map, then append any component
 * members the traversal missed (a fix round whose origin gate couldn't be matched)
 * so layout always covers every key.
 */
function orderLane(
  componentKeys: TicketKey[],
  augmented: Map<TicketKey, Set<TicketKey>>,
  ticketByKey: Map<TicketKey, KanbanTicket>
): { order: TicketKey[]; rootKey: TicketKey } {
  const rootKey = laneRootKey(componentKeys, ticketByKey)
  const fromRoot = getChainExecutionOrder(augmented, rootKey)
  const covered = new Set(fromRoot)
  const order = [...fromRoot, ...componentKeys.filter((k) => !covered.has(k))]
  return { order, rootKey }
}

/** Node id for a running node to auto-follow: the deepest-rank running+session node. */
function computeActiveNode(
  order: TicketKey[],
  ranks: Map<TicketKey, number>,
  ticketByKey: Map<TicketKey, KanbanTicket>
): TicketKey | null {
  let active: TicketKey | null = null
  let bestRank = -1
  for (const key of order) {
    const t = ticketByKey.get(key)
    if (!t || t.column !== 'in_progress' || !t.current_session_id) continue
    const r = ranks.get(key) ?? 0
    if (r >= bestRank) {
      bestRank = r
      active = key
    }
  }
  return active
}

function buildTicketNode(
  key: TicketKey,
  ticketByKey: Map<TicketKey, KanbanTicket>,
  realDepMap: Map<TicketKey, Set<TicketKey>>,
  componentSet: Set<TicketKey>,
  position: { x: number; y: number },
  activeKey: TicketKey | null
): WorkflowNode {
  const t = ticketByKey.get(key) as KanbanTicket
  const blockers = [...(realDepMap.get(key) ?? [])]
    .filter((b) => componentSet.has(b))
    .map((b) => ticketByKey.get(b))
    .filter((b): b is KanbanTicket => !!b)
  const phase = deriveNodePhase(t.title)
  const status = deriveNodeStatus(t, blockers)
  const round = parseRound(t.title) || (t.lifecycle_iteration ?? 0)
  const data: WorkflowNodeData = {
    ticketKey: key,
    ref: { projectId: t.project_id, ticketId: t.id },
    title: t.title,
    phase,
    status,
    isGate: isConditionGate(t.lifecycle_callbacks),
    isShardGate: isShardGate(t.lifecycle_callbacks),
    gateVerdict: t.condition_gate_result?.verdict ?? null,
    round,
    pulse: status === 'running' && !!t.current_session_id,
    prNumber: t.github_pr_number ?? null,
    prUrl: t.github_pr_url ?? null,
    isActive: key === activeKey
  }
  return {
    id: key,
    type: 'ticket',
    position,
    width: NODE_W,
    height: NODE_H,
    data
  }
}

function buildLaneEdges(
  componentKeys: TicketKey[],
  ticketByKey: Map<TicketKey, KanbanTicket>,
  realDepMap: Map<TicketKey, Set<TicketKey>>,
  loopPairs: Array<{ gate: TicketKey; fix: TicketKey }>,
  activeKey: TicketKey | null
): Edge[] {
  const componentSet = new Set(componentKeys)
  const edges: Edge[] = []

  // Real dependency edges: blocker (source, bottom) → dependent (target, top).
  for (const dependent of componentKeys) {
    for (const blocker of realDepMap.get(dependent) ?? []) {
      if (!componentSet.has(blocker)) continue
      const taken = ticketByKey.get(blocker)?.column === 'done'
      edges.push({
        id: `${blocker}->${dependent}`,
        source: blocker,
        target: dependent,
        animated: dependent === activeKey,
        style: {
          stroke: taken ? 'var(--primary)' : 'var(--border)',
          strokeWidth: taken ? 2 : 1.5
        }
      })
    }
  }

  // Fabricated dashed loop edges: gate → fix-r{N}.
  for (const { gate, fix } of loopPairs) {
    edges.push({
      id: `loop:${gate}->${fix}`,
      source: gate,
      target: fix,
      animated: fix === activeKey,
      style: {
        stroke: 'var(--chart-4)',
        strokeWidth: 1.75,
        strokeDasharray: '6 4'
      }
    })
  }
  return edges
}

/** Build one lane's nodes + edges, translated so its left edge sits at `offsetX`. */
function buildLane(
  componentKeys: TicketKey[],
  ticketByKey: Map<TicketKey, KanbanTicket>,
  realDepMap: Map<TicketKey, Set<TicketKey>>,
  offsetX: number
): {
  nodes: WorkflowNode[]
  edges: Edge[]
  activeKey: TicketKey | null
  rootKey: TicketKey
  width: number
  height: number
} {
  const { augmented, loopPairs } = fabricateFixLoopEdges(componentKeys, ticketByKey, realDepMap)
  const { order, rootKey } = orderLane(componentKeys, augmented, ticketByKey)
  const layout = layoutChain(order, augmented, 0)
  const componentSet = new Set(componentKeys)
  const activeKey = computeActiveNode(order, layout.ranks, ticketByKey)

  // Translate so the lane's leftmost node aligns to offsetX.
  let minX = Infinity
  for (const p of layout.positions.values()) if (p.x < minX) minX = p.x
  if (!Number.isFinite(minX)) minX = 0
  const shift = offsetX - minX

  const nodes: WorkflowNode[] = []
  for (const key of order) {
    const p = layout.positions.get(key)
    if (!p || !ticketByKey.has(key)) continue
    nodes.push(
      buildTicketNode(
        key,
        ticketByKey,
        realDepMap,
        componentSet,
        { x: p.x + shift, y: p.y },
        activeKey
      )
    )
  }
  const edges = buildLaneEdges(componentKeys, ticketByKey, realDepMap, loopPairs, activeKey)
  return { nodes, edges, activeKey, rootKey, width: layout.width, height: layout.height }
}

/** Build `ticketByKey` from a flat ticket list. */
function indexTickets(tickets: KanbanTicket[]): {
  ticketByKey: Map<TicketKey, KanbanTicket>
  ticketKeys: TicketKey[]
} {
  const ticketByKey = new Map<TicketKey, KanbanTicket>()
  const ticketKeys: TicketKey[] = []
  for (const t of tickets) {
    const key = keyOf(t)
    ticketByKey.set(key, t)
    ticketKeys.push(key)
  }
  return { ticketByKey, ticketKeys }
}

/**
 * Build the DAG for the single chain (lane) that contains `rootKey`. Used by the
 * per-chain focus modal. `rootKey` may be any member of the chain — the lane is
 * the worktree-unioned connected component it belongs to.
 */
export function buildChainGraph(
  rootKey: TicketKey,
  tickets: KanbanTicket[],
  dependencyMap: Map<TicketKey, Set<TicketKey>>
): ChainGraphResult {
  const { ticketByKey, ticketKeys } = indexTickets(tickets)
  if (!ticketByKey.has(rootKey)) {
    return { nodes: [], edges: [], activeNodeId: null, rootKey: null }
  }
  const components = groupChains(ticketKeys, dependencyMap, ticketByKey)
  const component = components.find((c) => c.includes(rootKey)) ?? [rootKey]
  const lane = buildLane(component, ticketByKey, dependencyMap, 0)
  return {
    nodes: lane.nodes,
    edges: lane.edges,
    activeNodeId: lane.activeKey,
    rootKey: lane.rootKey
  }
}

/**
 * Build the board-level DAG: every chain rendered as its own lane, laid out
 * side-by-side. Lanes with a running node come first, then dependency-less
 * singletons are de-emphasized and sorted last; the rest by root `created_at`.
 * Each lane gets a non-interactive label node (root title + running indicator).
 */
export function buildBoardGraph(
  projectTickets: KanbanTicket[],
  dependencyMap: Map<TicketKey, Set<TicketKey>>
): WorkflowGraphResult {
  const { ticketByKey, ticketKeys } = indexTickets(projectTickets)
  const components = groupChains(ticketKeys, dependencyMap, ticketByKey)

  // Pre-build each lane at offset 0 to know its size + running state, then sort.
  const lanes = components.map((component) => {
    const built = buildLane(component, ticketByKey, dependencyMap, 0)
    const rootTicket = ticketByKey.get(built.rootKey)
    return {
      component,
      built,
      isSingleton: component.length <= 1,
      hasRunning: built.activeKey !== null,
      rootTitle: rootTicket?.title ?? 'Chain',
      rootCreatedAt: rootTicket?.created_at ?? ''
    }
  })

  lanes.sort((a, b) => {
    // Running lanes first.
    if (a.hasRunning !== b.hasRunning) return a.hasRunning ? -1 : 1
    // Singletons last.
    if (a.isSingleton !== b.isSingleton) return a.isSingleton ? 1 : -1
    // Otherwise by root created_at (oldest first), tie by root key.
    if (a.rootCreatedAt !== b.rootCreatedAt) return a.rootCreatedAt < b.rootCreatedAt ? -1 : 1
    return a.built.rootKey < b.built.rootKey ? -1 : 1
  })

  const nodes: Node[] = []
  const edges: Edge[] = []
  let activeNodeId: string | null = null
  let laneOffsetX = 0

  for (const lane of lanes) {
    // Re-run the lane at the current offset so node x-coordinates are final.
    const placed = buildLane(lane.component, ticketByKey, dependencyMap, laneOffsetX)
    // Lane label above rank 0.
    nodes.push({
      id: `lane-label:${placed.rootKey}`,
      type: 'laneLabel',
      position: { x: laneOffsetX, y: -70 },
      draggable: false,
      selectable: false,
      focusable: false,
      data: { title: lane.rootTitle, running: placed.activeKey !== null } as LaneLabelData
    })
    nodes.push(...placed.nodes)
    edges.push(...placed.edges)
    if (!activeNodeId && placed.activeKey) activeNodeId = placed.activeKey
    laneOffsetX += lane.built.width + LANE_GAP
  }

  return { nodes, edges, activeNodeId }
}
