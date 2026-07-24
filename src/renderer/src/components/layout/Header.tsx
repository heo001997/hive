import { useEffect, useState, useRef } from 'react'
import { isMac } from '@/lib/platform'
import {
  PanelRightClose,
  PanelRightOpen,
  History,
  Settings,
  Coffee,
  MoonStar,
  Activity,
  Swords,
  Workflow
} from 'lucide-react'
import { KanbanIcon } from '@/components/kanban/KanbanIcon'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuCheckboxItem
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useFullscreenStore } from '@/stores/useFullscreenStore'
import { useSessionHistoryStore } from '@/stores/useSessionHistoryStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSleepWhenIdleStore } from '@/stores/useSleepWhenIdleStore'
import { useVimModeStore } from '@/stores/useVimModeStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWarRoomStore } from '@/stores/useWarRoomStore'
import { useBoardSearchStore } from '@/stores/useBoardSearchStore'
import { BoardSearchControl } from '@/components/kanban/BoardSearchControl'
import { useTipStore } from '@/stores/useTipStore'
import { Tip } from '@/components/ui/Tip'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useMonitorStore } from '@/stores/useMonitorStore'
import { HeaderTelegramToggle } from './HeaderTelegramToggle'
import { HeaderDiscordToggle } from './HeaderDiscordToggle'
import hiveLogo from '@/assets/icon.png'

export function Header(): React.JSX.Element {
  const { rightSidebarCollapsed, toggleRightSidebar } = useLayoutStore()
  const isFullscreen = useFullscreenStore((s) => s.isFullscreen)
  const { openPanel: openSessionHistory } = useSessionHistoryStore()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()

  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const boardMode = useSettingsStore((s) => s.boardMode)
  const customLogoDataUrl = useSettingsStore((s) => s.customLogoDataUrl)
  const customAppName = useSettingsStore((s) => s.customAppName)
  const appName = customAppName.trim() || 'Hive'
  const keepAwakeEnabled = useSettingsStore((s) => s.keepAwakeEnabled)
  const streamingCount = useWorktreeStatusStore((state) =>
    Object.values(state.sessionStatuses).filter(
      (entry) => entry && (entry.status === 'working' || entry.status === 'planning')
    ).length
  )
  const sleepWhenIdleArmed = useSleepWhenIdleStore((s) => s.armed)
  const toggleSleepWhenIdle = useSleepWhenIdleStore((s) => s.toggle)
  const mugIsOn = keepAwakeEnabled && streamingCount > 0
  const isBoardViewActive = useKanbanStore((s) => s.isBoardViewActive)
  const boardSearchMounted = useBoardSearchStore((s) => s.mounted)
  const toggleBoardView = useKanbanStore((s) => s.toggleBoardView)
  const isWorkflowViewActive = useKanbanStore((s) => s.isWorkflowViewActive)
  const toggleWorkflowView = useKanbanStore((s) => s.toggleWorkflowView)
  const isWarRoomViewActive = useWarRoomStore((s) => s.isWarRoomViewActive)
  const toggleWarRoomView = useWarRoomStore((s) => s.toggleWarRoomView)
  const kanbanIconSeen = useTipStore((s) => s.isTipSeen('kanban-icon'))
  const hatchFirstPetSeen = useTipStore((s) => s.isTipSeen('hatch-first-pet'))
  const nonDefaultProviderChosen = useTipStore((s) => s.nonDefaultProviderChosen)
  const petEnabled = useSettingsStore((s) => s.pet.enabled)

  const showHatchTip = !hatchFirstPetSeen && !petEnabled
  const settingsTipId = showHatchTip ? 'hatch-first-pet' : 'settings-default-provider'
  const settingsTipEnabled = showHatchTip ? true : nonDefaultProviderChosen

  // Track first-time kanban exit for the kanban-reenter tip
  const [justExitedKanban, setJustExitedKanban] = useState(false)
  const prevBoardActive = useRef(isBoardViewActive)
  useEffect(() => {
    if (prevBoardActive.current && !isBoardViewActive) {
      setJustExitedKanban(true)
    }
    prevBoardActive.current = isBoardViewActive
  }, [isBoardViewActive])

  const hasProjects = projects.length > 0

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const selectedWorktree = (() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt
    }
    return null
  })()

  // Connection mode detection
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectedConnection = useConnectionStore((s) =>
    s.selectedConnectionId ? s.connections.find((c) => c.id === s.selectedConnectionId) : null
  )
  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  const openMonitor = useMonitorStore((s) => s.open)
  const unseenAlertCount = useMonitorStore((s) => s.unseenAlertCount)

  return (
    <header
      className={cn(
        'h-12 border-b bg-background flex items-center justify-between pr-4 flex-shrink-0 select-none',
        // On macOS (windowed) the traffic-light spacer below provides the left
        // inset; otherwise add the left padding so the logo isn't jammed into the
        // corner. In macOS fullscreen the window buttons are hidden, so the logo
        // goes flush-left like every other platform.
        (!isMac() || isFullscreen) && 'pl-4'
      )}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="header"
    >
      {/* Spacer for macOS traffic lights: clears the window buttons (x:15 + ~52px
          cluster) with a small gap so the logo sits flush-left right after them.
          Hidden in fullscreen, where the traffic lights are not shown. */}
      {isMac() && !isFullscreen && <div className="w-[72px] flex-shrink-0" />}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <img
          src={customLogoDataUrl || hiveLogo}
          alt={appName}
          className="h-5 w-5 shrink-0 rounded object-contain"
          draggable={false}
        />
        {isConnectionMode && selectedConnection ? (
          <span className="text-sm font-medium truncate" data-testid="header-connection-info">
            {selectedConnection.name}
            <span className="text-primary font-normal">
              {' '}
              ({selectedConnection.members.map((m) => m.project_name).join(' + ')})
            </span>
          </span>
        ) : selectedProject ? (
          <span className="text-sm font-medium truncate" data-testid="header-project-info">
            {selectedProject.name}
            {selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
              <span className="text-primary font-normal"> ({selectedWorktree.branch_name})</span>
            )}
          </span>
        ) : (
          <span className="text-sm font-medium">{appName}</span>
        )}
        {keepAwakeEnabled && (
          <ContextMenu>
            <ContextMenuTrigger asChild disabled={!mugIsOn}>
              <span
                className="inline-flex shrink-0"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        'shrink-0',
                        streamingCount > 0 ? 'text-amber-500' : 'text-muted-foreground',
                        sleepWhenIdleArmed && 'text-indigo-400'
                      )}
                      data-testid="keep-awake-indicator"
                    >
                      <Coffee className="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={8}>
                    {sleepWhenIdleArmed
                      ? 'Will sleep when all sessions have been idle for 1 minute.'
                      : 'Prevents your computer from sleeping while a session is running'}
                  </TooltipContent>
                </Tooltip>
              </span>
            </ContextMenuTrigger>
            {mugIsOn && (
              <ContextMenuContent>
                <ContextMenuCheckboxItem
                  checked={sleepWhenIdleArmed}
                  onCheckedChange={toggleSleepWhenIdle}
                >
                  <MoonStar className="h-4 w-4 mr-2" />
                  Sleep when idle
                </ContextMenuCheckboxItem>
              </ContextMenuContent>
            )}
          </ContextMenu>
        )}
        {vimModeEnabled && (
          <span
            className={cn(
              'text-[10px] font-mono px-1.5 py-0.5 rounded border select-none',
              vimMode === 'normal'
                ? 'text-muted-foreground bg-muted/50 border-border/50'
                : 'text-primary bg-primary/10 border-primary/30'
            )}
            data-testid="vim-mode-pill"
          >
            {vimMode === 'normal' ? 'NORMAL' : 'INSERT'}
          </span>
        )}
      </div>
      <div
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {boardMode === 'toggle' && (
          <Tip
            tipId={kanbanIconSeen ? 'kanban-reenter' : 'kanban-icon'}
            enabled={kanbanIconSeen ? justExitedKanban : hasProjects}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                const fileStore = useFileViewerStore.getState()
                if (!isBoardViewActive) {
                  fileStore.clearActiveViews()
                  useWarRoomStore.getState().setWarRoomViewActive(false)
                  if (useKanbanStore.getState().isWorkflowViewActive) toggleWorkflowView()
                  toggleBoardView()
                } else if (fileStore.hasActiveOverlay()) {
                  fileStore.clearActiveViews()
                } else {
                  toggleBoardView()
                }
              }}
              title={isBoardViewActive ? 'Close Board' : 'Open Board'}
              data-testid="kanban-board-toggle"
              className={cn(
                isBoardViewActive && 'bg-accent text-accent-foreground'
              )}
            >
              <KanbanIcon className="h-4 w-4" />
            </Button>
          </Tip>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            if (!isWarRoomViewActive) {
              useFileViewerStore.getState().clearActiveViews()
              if (useKanbanStore.getState().isBoardViewActive) {
                toggleBoardView()
              }
              if (useKanbanStore.getState().isWorkflowViewActive) {
                toggleWorkflowView()
              }
            }
            toggleWarRoomView()
          }}
          title={isWarRoomViewActive ? 'Close War Rooms' : 'Open War Rooms'}
          data-testid="war-room-toggle"
          className={cn(isWarRoomViewActive && 'bg-accent text-accent-foreground')}
        >
          <Swords className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            if (!isWorkflowViewActive) {
              useFileViewerStore.getState().clearActiveViews()
              useWarRoomStore.getState().setWarRoomViewActive(false)
              if (useKanbanStore.getState().isBoardViewActive) {
                toggleBoardView()
              }
            }
            toggleWorkflowView()
          }}
          title={isWorkflowViewActive ? 'Close Workflow' : 'Open Workflow'}
          data-testid="workflow-view-toggle"
          className={cn(isWorkflowViewActive && 'bg-accent text-accent-foreground')}
        >
          <Workflow className="h-4 w-4" />
        </Button>
        {boardSearchMounted && <BoardSearchControl />}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openMonitor()}
          title="System Monitor"
          data-testid="system-monitor-toggle"
          className="relative"
        >
          <Activity className="h-4 w-4" />
          {unseenAlertCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-[10px] font-medium leading-[16px] text-white text-center"
              data-testid="monitor-alert-badge"
            >
              {unseenAlertCount > 99 ? '99+' : unseenAlertCount}
            </span>
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={openSessionHistory}
          title="Session History (⌘K)"
          data-testid="session-history-toggle"
        >
          <History className="h-4 w-4" />
        </Button>
        <HeaderTelegramToggle />
        <HeaderDiscordToggle />
        <Tip tipId={settingsTipId} enabled={settingsTipEnabled}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openSettings()}
            title="Settings (⌘,)"
            data-testid="settings-toggle"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </Tip>
        <Button
          onClick={toggleRightSidebar}
          variant="ghost"
          size="icon"
          title={rightSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          data-testid="right-sidebar-toggle"
        >
          {rightSidebarCollapsed ? (
            <PanelRightOpen className="h-4 w-4" />
          ) : (
            <PanelRightClose className="h-4 w-4" />
          )}
        </Button>
      </div>
    </header>
  )
}
