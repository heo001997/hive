import { Terminal, Play, Square, Wrench, Archive } from 'lucide-react'
import {
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuItem
} from '@/components/ui/context-menu'
import { useTicketScripts } from '@/hooks/useTicketScripts'
import type { KanbanTicket } from '../../../../main/db/types'

interface TicketScriptsSubmenuProps {
  ticket: KanbanTicket
}

/**
 * Context-menu submenu listing the project's configured on-demand shell scripts
 * (Run / Setup / Archive) and running them against the ticket's worktree.
 * Renders nothing when no scripts are configured.
 */
export function TicketScriptsSubmenu({ ticket }: TicketScriptsSubmenuProps): React.JSX.Element | null {
  const { worktreePath, hasAnyScript, run, setup, archive } = useTicketScripts(ticket)

  if (!hasAnyScript) return null

  const noWorktree = !worktreePath

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="ctx-scripts-submenu" className="gap-2">
        <Terminal className="h-3.5 w-3.5" />
        Scripts
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {noWorktree && (
          <ContextMenuItem disabled className="text-muted-foreground text-xs">
            Worktree not available
          </ContextMenuItem>
        )}

        {run.configured && (
          <ContextMenuItem
            data-testid="ctx-run-script"
            disabled={noWorktree}
            onClick={() => (run.running ? void run.stop() : run.start())}
            className="gap-2"
          >
            {run.running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {run.running ? 'Stop Run Script' : 'Run Script'}
          </ContextMenuItem>
        )}

        {setup.configured && (
          <ContextMenuItem
            data-testid="ctx-setup-script"
            disabled={noWorktree || setup.running}
            onClick={() => setup.start()}
            className="gap-2"
          >
            <Wrench className="h-3.5 w-3.5" />
            Run Setup Script
          </ContextMenuItem>
        )}

        {archive.configured && (
          <ContextMenuItem
            data-testid="ctx-archive-script"
            disabled={noWorktree || archive.running}
            onClick={() => void archive.start()}
            className="gap-2"
          >
            <Archive className="h-3.5 w-3.5" />
            Run Archive Script
          </ContextMenuItem>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
