import { useProjectStore } from '@/stores/useProjectStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore, BOARD_TAB_ID } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

/**
 * Custom markdown link scheme the Board Assistant uses to reference an existing
 * (or just-created) kanban ticket. Clicking such a link navigates back to the
 * board and opens that ticket's detail modal. See `MarkdownRenderer`.
 */
export const HIVE_TICKET_LINK_PREFIX = 'hive-ticket:'

/** Build a `hive-ticket:` href encoding a project-scoped ticket reference. */
export function buildTicketLinkHref(projectId: string, ticketId: string): string {
  return `${HIVE_TICKET_LINK_PREFIX}${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}`
}

/** Parse a `hive-ticket:` href back into its project/ticket ids, or null if it isn't one. */
export function parseTicketLinkHref(
  href: string | undefined
): { projectId: string; ticketId: string } | null {
  if (!href || !href.startsWith(HIVE_TICKET_LINK_PREFIX)) return null
  const rest = href.slice(HIVE_TICKET_LINK_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  try {
    const projectId = decodeURIComponent(rest.slice(0, slash))
    const ticketId = decodeURIComponent(rest.slice(slash + 1))
    if (!projectId || !ticketId) return null
    return { projectId, ticketId }
  } catch {
    return null
  }
}

/**
 * Navigate to the Kanban board for `projectId` and open `ticketId`'s detail
 * modal. Mirrors BoardAssistantView.navigateToBoard for the board-switch half,
 * then loads tickets (so the modal can resolve the ticket) and selects it.
 *
 * Safe no-op if the ticket no longer exists: the modal resolves to null.
 */
export async function openTicketDetail(projectId: string, ticketId: string): Promise<void> {
  const projectStore = useProjectStore.getState()
  if (projectStore.selectedProjectId !== projectId) {
    projectStore.selectProject(projectId)
  }

  // Load tickets before revealing the modal so the detail lookup resolves.
  await useKanbanStore.getState().loadTickets(projectId)

  // Leave any Board Assistant / file-viewer focus and reveal the board, matching
  // BoardAssistantView.navigateToBoard (incl. sticky-tab board mode).
  useFileViewerStore.getState().clearActiveViews()
  const sessionStore = useSessionStore.getState()
  sessionStore.setActivePinnedSession(null)
  if (useSettingsStore.getState().boardMode === 'sticky-tab') {
    sessionStore.setActiveSession(BOARD_TAB_ID)
  } else {
    sessionStore.clearBoardAssistantFocus()
    const kanbanStore = useKanbanStore.getState()
    if (!kanbanStore.isBoardViewActive) {
      kanbanStore.toggleBoardView()
    }
  }

  useKanbanStore.getState().setSelectedTicketRef({ projectId, ticketId })
}
