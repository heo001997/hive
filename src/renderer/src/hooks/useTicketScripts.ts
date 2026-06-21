import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore, fireSetupScript } from '@/stores/useWorktreeStore'
import { useScriptStore, fireRunScript, killRunScript } from '@/stores/useScriptStore'
import { scriptApi } from '@/api/script-api'
import { toast } from '@/lib/toast'
import type { KanbanTicket } from '../../../main/db/types'
import { dbApi } from '@/api/db-api'

type TicketScriptsWorktree = {
  path: string
}

/** Parse a newline-separated script string into runnable commands (drop blanks/comments). */
function parseCommands(script: string | null): string[] {
  if (!script) return []
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

export interface TicketScriptControl {
  /** True when the project has commands configured for this script. */
  configured: boolean
  /** True while this script is executing for the ticket's worktree. */
  running: boolean
  /** Start the script in the ticket's worktree.  No-op when not runnable. */
  start: () => void
}

export interface TicketRunScriptControl extends TicketScriptControl {
  /** Kill the running script in this ticket's worktree. */
  stop: () => Promise<void>
}

/**
 * Combined state + actions for running the project's on-demand shell scripts
 * (run / setup / archive) against a ticket's attached worktree.  Mirrors
 * `useTicketRunScript` — both read/write the same `useScriptStore`, so run/stop
 * stay consistent between the ticket modal button and this context-menu submenu.
 */
export interface TicketScriptsState {
  /** Resolved worktree path, or null while unresolved / unattached. */
  worktreePath: string | null
  /** True when at least one of the three scripts has commands configured. */
  hasAnyScript: boolean
  run: TicketRunScriptControl
  setup: TicketScriptControl
  archive: TicketScriptControl
}

export function useTicketScripts(ticket: KanbanTicket): TicketScriptsState {
  // Reactive project selectors — keep `configured` flags in sync with edits made
  // in Project Settings while the menu is open.
  const runScript = useProjectStore(
    (s) => s.projects.find((p) => p.id === ticket.project_id)?.run_script ?? null
  )
  const setupScript = useProjectStore(
    (s) => s.projects.find((p) => p.id === ticket.project_id)?.setup_script ?? null
  )
  const archiveScript = useProjectStore(
    (s) => s.projects.find((p) => p.id === ticket.project_id)?.archive_script ?? null
  )

  // In-memory worktree lookup (reactive to worktreesByProject changes).
  const inMemoryWorktree = useWorktreeStore((s) => {
    if (!ticket.worktree_id) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === ticket.worktree_id)
      if (wt) return wt
    }
    return null
  })

  // DB fallback: hydrate from the DB when the worktree isn't in memory (e.g.
  // pinned-board cross-project views where the project isn't loaded).
  const [dbWorktree, setDbWorktree] = useState<TicketScriptsWorktree | null>(null)

  useEffect(() => {
    let cancelled = false

    if (!ticket.worktree_id) {
      setDbWorktree(null)
      return
    }
    if (inMemoryWorktree) {
      setDbWorktree(null)
      return
    }

    dbApi.worktree
      .get(ticket.worktree_id)
      .then((wt) => {
        if (!cancelled) setDbWorktree(wt ?? null)
      })
      .catch(() => {
        if (!cancelled) setDbWorktree(null)
      })

    return () => {
      cancelled = true
    }
  }, [ticket.worktree_id, inMemoryWorktree])

  const resolvedWorktree = inMemoryWorktree ?? dbWorktree
  const worktreePath = resolvedWorktree?.path ?? null

  // Reactive running flags shared with the modal run button / Cmd+R.
  const runRunning = useScriptStore((s) =>
    ticket.worktree_id ? (s.scriptStates[ticket.worktree_id]?.runRunning ?? false) : false
  )
  const setupRunning = useScriptStore((s) =>
    ticket.worktree_id ? (s.scriptStates[ticket.worktree_id]?.setupRunning ?? false) : false
  )
  // Archive is a blocking RPC with no per-worktree store state — track locally.
  const [archiveRunning, setArchiveRunning] = useState(false)

  const runConfigured = parseCommands(runScript).length > 0
  const setupConfigured = parseCommands(setupScript).length > 0
  const archiveConfigured = parseCommands(archiveScript).length > 0

  const startRun = useCallback(() => {
    if (!ticket.worktree_id || !worktreePath || runRunning) return
    const commands = parseCommands(runScript)
    if (commands.length === 0) return
    fireRunScript(ticket.worktree_id, commands, worktreePath)
    toast.success('Run script started')
  }, [ticket.worktree_id, worktreePath, runScript, runRunning])

  const stopRun = useCallback(async () => {
    if (!ticket.worktree_id) return
    await killRunScript(ticket.worktree_id)
    toast.success('Run script stopped')
  }, [ticket.worktree_id])

  const startSetup = useCallback(() => {
    if (!ticket.worktree_id || !worktreePath || setupRunning) return
    fireSetupScript(ticket.project_id, ticket.worktree_id, worktreePath)
    toast.success('Setup script started')
  }, [ticket.project_id, ticket.worktree_id, worktreePath, setupRunning])

  const startArchive = useCallback(async () => {
    if (!worktreePath || archiveRunning) return
    const commands = parseCommands(archiveScript)
    if (commands.length === 0) return
    setArchiveRunning(true)
    try {
      const result = await scriptApi.runArchive(commands, worktreePath)
      if (result.success) {
        toast.success('Archive script completed')
      } else {
        toast.error(result.error || 'Archive script failed')
      }
    } catch {
      toast.error('Archive script failed')
    } finally {
      setArchiveRunning(false)
    }
  }, [worktreePath, archiveScript, archiveRunning])

  const hasAnyScript = runConfigured || setupConfigured || archiveConfigured

  return useMemo(
    () => ({
      worktreePath,
      hasAnyScript,
      run: { configured: runConfigured, running: runRunning, start: startRun, stop: stopRun },
      setup: { configured: setupConfigured, running: setupRunning, start: startSetup },
      archive: { configured: archiveConfigured, running: archiveRunning, start: startArchive }
    }),
    [
      worktreePath,
      hasAnyScript,
      runConfigured,
      runRunning,
      startRun,
      stopRun,
      setupConfigured,
      setupRunning,
      startSetup,
      archiveConfigured,
      archiveRunning,
      startArchive
    ]
  )
}
