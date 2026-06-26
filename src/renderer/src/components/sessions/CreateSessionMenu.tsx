import { Plus, TerminalSquare } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tip } from '@/components/ui/Tip'
import { KanbanIcon } from '@/components/kanban/KanbanIcon'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTipStore } from '@/stores/useTipStore'
import { cn } from '@/lib/utils'
import type { AgentSdk } from '@shared/types/agent-sdk'

interface CreateSessionMenuProps {
  /**
   * Selecting a session type from the right-click / dropdown menu.
   * The menu handles the "provider-right-click" tip side-effects; the caller
   * only has to actually create the session.
   */
  onCreate: (sdk: AgentSdk) => void
  /**
   * Left-click on the + button. If omitted, a left-click opens the menu
   * (handled natively by the context-menu trigger).
   */
  onDefaultCreate?: () => void
  /** Show the "New Board Assistant" item (board only — not used in ticket detail). */
  includeBoardAssistant?: boolean
  onCreateBoardAssistant?: () => void
  triggerClassName?: string
  triggerTitle?: string
  'data-testid'?: string
}

/**
 * The shared "+" session-creation control: a button that creates a default
 * session on left-click and opens a provider menu on right-click. Used by both
 * the kanban board's SessionTabs and the ticket-detail terminal strip so the
 * list of session types lives in exactly one place.
 */
export function CreateSessionMenu({
  onCreate,
  onDefaultCreate,
  includeBoardAssistant = false,
  onCreateBoardAssistant,
  triggerClassName,
  triggerTitle = 'Create new session (right-click for options)',
  'data-testid': dataTestId = 'create-session'
}: CreateSessionMenuProps): React.JSX.Element {
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const defaultAgentSdk = useSettingsStore((state) => state.defaultAgentSdk)
  const multipleProvidersAvailable =
    [availableAgentSdks?.opencode, availableAgentSdks?.claude, availableAgentSdks?.codex].filter(
      Boolean
    ).length > 1

  const handleSelect = (sdk: AgentSdk): void => {
    // Tip logic for AI providers (not terminal) — mirrors the board's original behavior.
    if (sdk !== 'terminal') {
      useTipStore.getState().markTipAsSeen('provider-right-click')
      if (sdk !== defaultAgentSdk) {
        useTipStore.getState().setNonDefaultProviderChosen(true)
      }
    }
    onCreate(sdk)
  }

  return (
    <Tip tipId="provider-right-click" enabled={multipleProvidersAvailable}>
      <div className="shrink-0">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              onClick={onDefaultCreate}
              className={cn(
                'p-1.5 hover:bg-accent transition-colors border-r border-border',
                triggerClassName
              )}
              data-testid={dataTestId}
              title={triggerTitle}
            >
              <Plus className="h-4 w-4" />
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {availableAgentSdks?.opencode && (
              <ContextMenuItem onSelect={() => handleSelect('opencode')}>
                New OpenCode Session
              </ContextMenuItem>
            )}
            {availableAgentSdks?.claude && (
              <ContextMenuItem onSelect={() => handleSelect('claude-code')}>
                New Claude Code Session
              </ContextMenuItem>
            )}
            {availableAgentSdks?.claude && (
              <ContextMenuItem onSelect={() => handleSelect('claude-code-cli')}>
                New Claude Code CLI Session
              </ContextMenuItem>
            )}
            {availableAgentSdks?.codex && (
              <ContextMenuItem onSelect={() => handleSelect('codex')}>
                New Codex Session
              </ContextMenuItem>
            )}
            {(availableAgentSdks?.opencode ||
              availableAgentSdks?.claude ||
              availableAgentSdks?.codex) && <ContextMenuSeparator />}
            <ContextMenuItem onSelect={() => handleSelect('terminal')}>
              <TerminalSquare className="h-4 w-4 mr-2 text-emerald-500" />
              New Terminal
            </ContextMenuItem>
            {includeBoardAssistant && onCreateBoardAssistant && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={onCreateBoardAssistant}>
                  <KanbanIcon className="h-4 w-4 mr-2 text-blue-500" />
                  New Board Assistant
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </Tip>
  )
}
