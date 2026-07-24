import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeTypes
} from '@xyflow/react'
import { cn } from '@/lib/utils'
import { getThemeById } from '@/lib/themes'
import { useThemeStore } from '@/stores/useThemeStore'
import type { TicketRef } from '@/stores/useKanbanStore'
import { LaneLabelNode, TicketNode } from './TicketNode'
import { NODE_H, NODE_W, type WorkflowNodeData } from './lib/workflow-graph'

// Stable module-level object — a fresh `nodeTypes` per render makes React Flow warn
// and re-instantiate every node.
const NODE_TYPES: NodeTypes = { ticket: TicketNode, laneLabel: LaneLabelNode }

export interface WorkflowGraphProps {
  nodes: Node[]
  edges: Edge[]
  /** Node id to auto-center on when `follow` is on. */
  activeNodeId?: string | null
  /** Auto-follow the active node as the workflow advances. */
  follow?: boolean
  showMiniMap?: boolean
  onNodeOpen?: (ref: TicketRef) => void
  className?: string
}

/**
 * Handles fitView + auto-follow. Lives inside `<ReactFlowProvider>` so it can use
 * `useReactFlow()`. A dialog's open-animation starts the container at size 0, so we
 * cannot rely on the `fitView` prop alone — a `ResizeObserver` fires `fitView()`
 * once the container has real width (and on later resizes).
 */
function GraphViewportController({
  containerRef,
  activeNodeId,
  follow
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  activeNodeId?: string | null
  follow?: boolean
}): null {
  const { fitView, setCenter, getZoom, getNode } = useReactFlow()
  const pausedRef = useRef(false)
  const prevFollowRef = useRef(follow)

  // Fit once the container has real dimensions, and on subsequent size changes
  // (pane toggles / window resize). ResizeObserver does NOT fire on pan/zoom, so
  // this never fights the user mid-interaction.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        fitView({ padding: 0.2 })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef, fitView])

  // A new active node (workflow advanced) resumes following even after a pan.
  useEffect(() => {
    pausedRef.current = false
  }, [activeNodeId])

  // Re-enabling the Follow toggle resumes following.
  useEffect(() => {
    if (follow && !prevFollowRef.current) pausedRef.current = false
    prevFollowRef.current = follow
  }, [follow])

  useEffect(() => {
    if (!follow || pausedRef.current || !activeNodeId) return
    const node = getNode(activeNodeId)
    if (!node) return
    setCenter(node.position.x + NODE_W / 2, node.position.y + NODE_H / 2, {
      zoom: getZoom(),
      duration: 400
    })
  }, [follow, activeNodeId, getNode, setCenter, getZoom])

  // Expose the pause flag to the parent's onMoveStart via a custom event on the
  // container (keeps the ref private to this component).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onUserMove = (): void => {
      pausedRef.current = true
    }
    el.addEventListener('workflow:userpan', onUserMove)
    return () => el.removeEventListener('workflow:userpan', onUserMove)
  }, [containerRef])

  return null
}

/**
 * Dumb, shared React Flow core for both workflow surfaces (board pane + focus
 * modal). Controlled `nodes`/`edges` (stable ids = clean diff, viewport preserved).
 */
export function WorkflowGraph({
  nodes,
  edges,
  activeNodeId,
  follow = true,
  showMiniMap = false,
  onNodeOpen,
  className
}: WorkflowGraphProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const themeId = useThemeStore((s) => s.themeId)
  const isDark = useMemo(() => {
    const preset = getThemeById(themeId)
    if (preset) return preset.type === 'dark'
    return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  }, [themeId])

  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== 'ticket') return
      const ref = (node.data as WorkflowNodeData).ref
      if (ref) onNodeOpen?.(ref)
    },
    [onNodeOpen]
  )

  const handleMoveStart = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      // A non-null event means the user initiated the move (programmatic
      // setCenter passes null) — pause auto-follow.
      if (event) containerRef.current?.dispatchEvent(new CustomEvent('workflow:userpan'))
    },
    []
  )

  // Empty board / chain: never mount <ReactFlow> with 0 nodes.
  if (nodes.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center text-sm text-muted-foreground',
          className
        )}
      >
        No workflow to show yet.
      </div>
    )
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          colorMode={isDark ? 'dark' : 'light'}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          // Keep nodes selectable so they stay pointer-interactive: React Flow drops
          // a node's pointer events to `none` when it is non-draggable, non-connectable
          // AND non-selectable, which would break double-click-to-open and the PR-chip
          // button. Selection state itself is unused (we don't persist it).
          elementsSelectable
          onlyRenderVisibleElements
          // Double-click opens the ticket (onNodeDoubleClick); don't let React Flow's
          // default double-click-to-zoom swallow that gesture.
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          onNodeDoubleClick={handleNodeDoubleClick}
          onMoveStart={handleMoveStart}
          className="h-full w-full"
        >
          <Background color="var(--border)" gap={20} />
          <Controls showInteractive={false} />
          {showMiniMap && <MiniMap pannable zoomable />}
          <GraphViewportController
            containerRef={containerRef}
            activeNodeId={activeNodeId}
            follow={follow}
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
