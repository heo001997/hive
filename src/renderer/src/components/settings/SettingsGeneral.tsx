import { useEffect, useState } from 'react'
import { useThemeStore } from '@/stores/useThemeStore'
import { DEFAULT_THEME_ID } from '@/lib/themes'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  RotateCcw,
  RotateCw,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { getDesktopBridge } from '@/api/desktop-bridge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DEFAULT_AUTO_RESOLVE_CONFLICT_PROMPT } from '@/lib/autoResolveConflictPrompt'
import { DEFAULT_CONTEXT_TEMPLATE } from '@/lib/worktree-context-constants'
import {
  DEFAULT_CONDITION_GATE_KEY_PATTERN,
  DEFAULT_CONDITION_GATE_WORD_PATTERN,
  DEFAULT_FIX_PROMPT_TEMPLATE
} from '@/lib/ticket-lifecycle'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useAccountStore, useUsageStore } from '@/stores'
import { toast } from '@/lib/toast'
import type { UsageProvider } from '@shared/types/usage'
import {
  COMPLETION_CHECK_PROVIDERS,
  COMPLETION_PROVIDER_LABELS,
  DEFAULT_CONDITION_GATE_PROMPT,
  DEFAULT_STRICT_VERIFY_PROMPT
} from '@shared/types/completion'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'
import { isAgentSdkAvailable } from '@/lib/agent-sdk-availability'
import { completionApi } from '@/api/completion-api'

const SAVED_ACCOUNT_PROVIDERS: UsageProvider[] = ['anthropic', 'openai']

function SavedAccountsList(): React.JSX.Element {
  const savedAccounts = useUsageStore((s) => s.savedAccounts)
  const loadSavedAccounts = useUsageStore((s) => s.loadSavedAccounts)
  const removeSavedAccount = useUsageStore((s) => s.removeSavedAccount)
  const anthropicEmail = useAccountStore((s) => s.anthropicEmail)
  const openaiEmail = useAccountStore((s) => s.openaiEmail)
  const fetchEmail = useAccountStore((s) => s.fetchEmail)

  useEffect(() => {
    loadSavedAccounts().catch(() => {})
    fetchEmail('anthropic')
    fetchEmail('openai')
  }, [loadSavedAccounts, fetchEmail])

  const activeEmails: Record<UsageProvider, string | null> = {
    anthropic: anthropicEmail,
    openai: openaiEmail
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
      <div>
        <div className="text-sm font-medium">Saved accounts</div>
        <p className="text-xs text-muted-foreground">
          Remove accounts from the usage popup without signing out of provider CLIs.
        </p>
      </div>

      {SAVED_ACCOUNT_PROVIDERS.map((provider) => {
        const providerAccounts = savedAccounts[provider]
        const icon = provider === 'anthropic' ? claudeIcon : openaiIcon
        const label = provider === 'anthropic' ? 'Claude' : 'OpenAI'

        return (
          <div key={provider} className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <img src={icon} alt={label} className="h-3.5 w-3.5" />
              {label}
            </div>

            {providerAccounts.length === 0 ? (
              <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                No saved accounts yet. Use Claude or Codex to capture one.
              </div>
            ) : (
              <div className="space-y-1.5">
                {providerAccounts.map((account) => {
                  const isActive = activeEmails[provider] === account.email
                  const isExpired = account.status === 'stale'
                  return (
                    <div
                      key={account.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className={cn('truncate text-sm', isActive && 'font-semibold')}>
                          {account.email}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          {isActive && (
                            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              Active
                            </span>
                          )}
                          {isExpired && (
                            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              Expired
                            </span>
                          )}
                          {account.status === 'error' && (
                            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              Error
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => removeSavedAccount(account.id)}
                        aria-label={`Remove ${account.email}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function SettingsGeneral(): React.JSX.Element {
  const { setTheme } = useThemeStore()
  const {
    autoStartSession,
    autoPullBeforeWorktree,
    warnBeforeQuitting,
    boardMode,
    followUpTriggerColumn,
    autoPinBaseWorktreeOnBoardPrompt,
    automaticallyCreateTicket,
    kanbanAutoApproveReview,
    kanbanAutoCommitOnReview,
    kanbanAutoApproveDelaySeconds,
    kanbanStrictVerifyEnabled,
    kanbanStrictVerifySnapshotEnabled,
    kanbanStrictVerifyReviewerEnabled,
    kanbanStrictVerifyPrompt,
    kanbanStrictVerifyDelaySeconds,
    kanbanStrictVerifyFrozenIdleSeconds,
    kanbanStrictVerifyProvider,
    kanbanStrictVerifyModel,
    kanbanStrictVerifyChars,
    kanbanStrictVerifyConfidenceThreshold,
    kanbanInProgressRescueEnabled,
    kanbanQueuePromptsEnabled,
    kanbanIterateLoopEnabled,
    kanbanIterateLoopMaxIterations,
    kanbanIterateLoopFixPromptTemplate,
    kanbanConditionGateEnabled,
    kanbanConditionGateMaxRounds,
    kanbanConditionGateProvider,
    kanbanConditionGateModel,
    kanbanConditionGatePrompt,
    kanbanConditionGateAutoDone,
    kanbanConditionGateMatchMode,
    kanbanConditionGateKeyPattern,
    kanbanConditionGateWordPattern,
    vimModeEnabled,
    keepAwakeEnabled,
    mergeConflictMode,
    autoResolveConflictPrompt,
    protectedBranches,
    autoApprovePlanEnabled,
    autoApprovePlanMatchText,
    injectWorktreeContextEnabled,
    worktreeContextTemplate,
    tipsEnabled,
    breedType,
    showModelIcons,
    showModelProvider,
    usageIndicatorMode,
    usageIndicatorProviders,
    defaultAgentSdk,
    availableAgentSdks,
    stripAtMentions,
    updateSetting,
    resetToDefaults
  } = useSettingsStore()
  const { resetToDefaults: resetShortcuts } = useShortcutStore()

  // Local draft so typing stays smooth; persists on blur (mirrors SettingsTeleport).
  const [protectedBranchesDraft, setProtectedBranchesDraft] = useState(protectedBranches)
  useEffect(() => {
    setProtectedBranchesDraft(protectedBranches)
  }, [protectedBranches])

  const [autoResolvePromptDraft, setAutoResolvePromptDraft] = useState(autoResolveConflictPrompt)
  useEffect(() => {
    setAutoResolvePromptDraft(autoResolveConflictPrompt)
  }, [autoResolveConflictPrompt])

  const [autoApprovePlanDraft, setAutoApprovePlanDraft] = useState(autoApprovePlanMatchText)
  const [worktreeContextDraft, setWorktreeContextDraft] = useState(worktreeContextTemplate)
  useEffect(() => {
    setAutoApprovePlanDraft(autoApprovePlanMatchText)
  }, [autoApprovePlanMatchText])

  // Strict Verify "Test" button — probes whether the configured provider + model
  // can actually be called (CLI installed, model id valid, authenticated).
  const [verifyTest, setVerifyTest] = useState<{
    status: 'idle' | 'running' | 'ok' | 'fail'
    message?: string
  }>({ status: 'idle' })

  const handleTestStrictVerifyProvider = async (): Promise<void> => {
    setVerifyTest({ status: 'running' })
    try {
      const res = await completionApi.testStrictVerifyProvider({
        provider: kanbanStrictVerifyProvider,
        model: kanbanStrictVerifyModel || undefined,
        systemPrompt: kanbanStrictVerifyPrompt || undefined
      })
      if (res.success && res.verdict) {
        const label = COMPLETION_PROVIDER_LABELS[kanbanStrictVerifyProvider]
        const modelNote = kanbanStrictVerifyModel ? ` · ${kanbanStrictVerifyModel}` : ''
        setVerifyTest({ status: 'ok', message: `${label}${modelNote} reachable` })
      } else {
        setVerifyTest({ status: 'fail', message: res.error ?? 'Provider returned no verdict' })
      }
    } catch (err) {
      setVerifyTest({ status: 'fail', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleResetAll = (): void => {
    resetToDefaults()
    resetShortcuts()
    setTheme(DEFAULT_THEME_ID)
    toast.success('All settings reset to defaults')
  }

  // Restart Hive — only meaningful in the desktop app, where the preload bridge
  // can quit + relaunch the process. Absent in browser/server mode.
  const canRelaunch = !!getDesktopBridge()?.relaunchApp
  const [restarting, setRestarting] = useState(false)

  const handleRestart = async (): Promise<void> => {
    const relaunchApp = getDesktopBridge()?.relaunchApp
    if (!relaunchApp) return
    setRestarting(true)
    try {
      // Resolves as the app is quitting, so the spinner persists until exit.
      await relaunchApp()
    } catch (err) {
      setRestarting(false)
      toast.error(err instanceof Error ? err.message : 'Failed to restart Hive')
    }
  }

  const toggleProvider = (provider: UsageProvider): void => {
    const current = usageIndicatorProviders
    const updated = current.includes(provider)
      ? current.filter((p) => p !== provider)
      : [...current, provider]
    updateSetting('usageIndicatorProviders', updated)
  }

  const opencodeAvailable = isAgentSdkAvailable('opencode', availableAgentSdks)
  const claudeAvailable = isAgentSdkAvailable('claude-code', availableAgentSdks)
  const claudeCliAvailable = isAgentSdkAvailable('claude-code-cli', availableAgentSdks)
  const codexAvailable = isAgentSdkAvailable('codex', availableAgentSdks)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">General</h3>
        <p className="text-sm text-muted-foreground">Basic application settings</p>
      </div>

      {/* Warn before quitting */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <label className="text-sm font-medium">Warn before quitting (⌘Q)</label>
          <p className="text-xs text-muted-foreground">
            Show a confirmation when you press ⌘Q. Press ⌘Q a second time within 2 seconds to quit.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={warnBeforeQuitting}
          onClick={() => updateSetting('warnBeforeQuitting', !warnBeforeQuitting)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            warnBeforeQuitting ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="warn-before-quitting-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              warnBeforeQuitting ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Auto-start session */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Auto-start session</label>
          <p className="text-xs text-muted-foreground">
            Automatically create a session when selecting a worktree with none
          </p>
        </div>
        <button
          role="switch"
          aria-checked={autoStartSession}
          onClick={() => updateSetting('autoStartSession', !autoStartSession)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            autoStartSession ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="auto-start-session-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              autoStartSession ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Auto-pull before worktree creation */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Auto-pull before worktree creation</label>
          <p className="text-xs text-muted-foreground">
            Automatically pull from origin before creating worktrees to ensure they're up-to-date
          </p>
        </div>
        <button
          role="switch"
          aria-checked={autoPullBeforeWorktree}
          onClick={() => updateSetting('autoPullBeforeWorktree', !autoPullBeforeWorktree)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            autoPullBeforeWorktree ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="auto-pull-before-worktree-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              autoPullBeforeWorktree ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Board Mode */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Board Mode</label>
        <p className="text-xs text-muted-foreground">Choose how the Kanban board is accessed.</p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('boardMode', 'toggle')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              boardMode === 'toggle'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="board-mode-toggle"
          >
            Toggle
          </button>
          <button
            onClick={() => updateSetting('boardMode', 'sticky-tab')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              boardMode === 'sticky-tab'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="board-mode-sticky-tab"
          >
            Sticky Tab
          </button>
        </div>
      </div>

      {/* Follow-up ticket trigger */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Follow-up Ticket Trigger</label>
        <p className="text-xs text-muted-foreground">
          When should blocked tickets auto-launch? When all blockers reach this column.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('followUpTriggerColumn', 'review')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              followUpTriggerColumn === 'review'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="follow-up-trigger-review"
          >
            Review
          </button>
          <button
            onClick={() => updateSetting('followUpTriggerColumn', 'done')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              followUpTriggerColumn === 'done'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="follow-up-trigger-done"
          >
            Done
          </button>
        </div>
      </div>

      {/* Auto-pin project on board prompts */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <label className="text-sm font-medium">Auto-pin project on board prompts</label>
          <p className="text-xs text-muted-foreground">
            When a board action sends a prompt for a ticket, automatically pin the project's base
            worktree so its tickets appear on the pinned board.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={autoPinBaseWorktreeOnBoardPrompt}
          onClick={() =>
            updateSetting('autoPinBaseWorktreeOnBoardPrompt', !autoPinBaseWorktreeOnBoardPrompt)
          }
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            autoPinBaseWorktreeOnBoardPrompt ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="auto-pin-base-worktree-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              autoPinBaseWorktreeOnBoardPrompt ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Automatically create ticket */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <label className="text-sm font-medium">Automatically create ticket</label>
          <p className="text-xs text-muted-foreground">
            When you send the first message in a session you started yourself, create a ticket in
            that project (using the first words of your prompt as the title) and keep its title in
            sync as the session is renamed.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={automaticallyCreateTicket}
          onClick={() => updateSetting('automaticallyCreateTicket', !automaticallyCreateTicket)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            automaticallyCreateTicket ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="automatically-create-ticket-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              automaticallyCreateTicket ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Kanban — Strict Verify Ticket Review State (Feature A) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">Strict Verify Ticket Review State</label>
            <p className="text-xs text-muted-foreground">
              When a <strong>build</strong> ticket settles in Review, first run a deterministic{' '}
              <em>frozen check</em> (is the session still emitting output?), then an AI{' '}
              <em>Watcher</em> that judges complete / asking-a-question / incomplete. If the session
              is still streaming, the agent is waiting on you, or the work isn&apos;t convincingly
              done, the ticket goes back to <strong>In Progress</strong> (with a
              &quot;Questions&quot; badge when it&apos;s waiting on you). Runs for every build
              ticket that settles in Review, independent of Auto-approve.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={kanbanStrictVerifyEnabled}
            onClick={() => updateSetting('kanbanStrictVerifyEnabled', !kanbanStrictVerifyEnabled)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              kanbanStrictVerifyEnabled ? 'bg-primary' : 'bg-muted'
            )}
            data-testid="strict-verify-toggle"
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                kanbanStrictVerifyEnabled ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>

        {kanbanStrictVerifyEnabled && (
          <div className="ml-2 space-y-5 border-l-2 border-border pl-4">
            {/* Shared settle window — gates when BOTH sub-gates run. */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Verify after</label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={kanbanStrictVerifyDelaySeconds}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val >= 0 && val <= 600) {
                      updateSetting('kanbanStrictVerifyDelaySeconds', val)
                    }
                  }}
                  className="w-20 font-mono text-sm"
                  data-testid="strict-verify-delay"
                />
                <span className="text-xs text-muted-foreground">seconds (0-600)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                The ticket must sit idle in Review this long before the gates below run. The timer
                resets if the session resumes working.
              </p>
            </div>

            {/* ── Gate 1 · Snapshot (frozen check) ───────────────────────────── */}
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label className="text-sm font-medium">1 · Snapshot (frozen check)</label>
                  <p className="text-xs text-muted-foreground">
                    Deterministic, no model call. The frozen check <strong>always</strong> runs
                    before the Reviewer: if the session is <em>still emitting output</em> the agent
                    hasn&apos;t really stopped, so the ticket goes back to <strong>In Progress</strong>{' '}
                    and the Reviewer never runs. On: fingerprint at arm vs. at fire (spans the whole
                    wait). Off: a quick fresh re-sample at fire time.
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={kanbanStrictVerifySnapshotEnabled}
                  onClick={() =>
                    updateSetting(
                      'kanbanStrictVerifySnapshotEnabled',
                      !kanbanStrictVerifySnapshotEnabled
                    )
                  }
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                    kanbanStrictVerifySnapshotEnabled ? 'bg-primary' : 'bg-muted'
                  )}
                  data-testid="strict-verify-snapshot-toggle"
                >
                  <span
                    className={cn(
                      'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                      kanbanStrictVerifySnapshotEnabled ? 'translate-x-4' : 'translate-x-0'
                    )}
                  />
                </button>
              </div>

              {kanbanStrictVerifySnapshotEnabled && (
                <div className="space-y-2 border-t border-border pt-3">
                  <label className="text-sm font-medium">Frozen after</label>
                  <div className="flex items-center gap-3">
                    <Input
                      type="number"
                      min={2}
                      max={30}
                      value={kanbanStrictVerifyFrozenIdleSeconds}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10)
                        if (!isNaN(val) && val >= 2 && val <= 30) {
                          updateSetting('kanbanStrictVerifyFrozenIdleSeconds', val)
                        }
                      }}
                      className="w-20 font-mono text-sm"
                      data-testid="strict-verify-frozen-idle"
                    />
                    <span className="text-xs text-muted-foreground">seconds (2-30)</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Counts as frozen after this many seconds of terminal silence. Must exceed the
                    CLI&apos;s 1s clock tick — 2s is the floor.
                  </p>
                </div>
              )}
            </div>

            {/* ── Gate 2 · Ticket Reviewer (LLM) ─────────────────────────────── */}
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label className="text-sm font-medium">2 · Ticket Reviewer (LLM)</label>
                  <p className="text-xs text-muted-foreground">
                    An AI reads the transcript tail and judges complete / asking-a-question /
                    incomplete. If it&apos;s waiting on you, not done, or below the confidence
                    threshold, the ticket goes back to <strong>In Progress</strong> (with a
                    &quot;Questions&quot; badge when it&apos;s waiting on you). Turn off to treat a
                    ticket that clears the snapshot as verified.{' '}
                    <strong>Auto-skipped on gate/review tickets</strong> — they use the review→fix
                    loop, whose &quot;CHANGES REQUESTED&quot; prose the Reviewer would misread as
                    incomplete. Override per ticket in its Verification section.
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={kanbanStrictVerifyReviewerEnabled}
                  onClick={() =>
                    updateSetting(
                      'kanbanStrictVerifyReviewerEnabled',
                      !kanbanStrictVerifyReviewerEnabled
                    )
                  }
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                    kanbanStrictVerifyReviewerEnabled ? 'bg-primary' : 'bg-muted'
                  )}
                  data-testid="strict-verify-reviewer-toggle"
                >
                  <span
                    className={cn(
                      'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                      kanbanStrictVerifyReviewerEnabled ? 'translate-x-4' : 'translate-x-0'
                    )}
                  />
                </button>
              </div>

              {kanbanStrictVerifyReviewerEnabled && (
                <div className="space-y-3 border-t border-border pt-3">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">AI provider</label>
                    <select
                      value={kanbanStrictVerifyProvider}
                      onChange={(e) =>
                        updateSetting(
                          'kanbanStrictVerifyProvider',
                          e.target.value as typeof kanbanStrictVerifyProvider
                        )
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      data-testid="strict-verify-provider"
                    >
                      {COMPLETION_CHECK_PROVIDERS.map((provider) => (
                        <option key={provider} value={provider}>
                          {COMPLETION_PROVIDER_LABELS[provider]}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Which CLI runs the Reviewer. Falls back to another installed provider if this
                      one isn&apos;t available.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>
                    <Input
                      type="text"
                      value={kanbanStrictVerifyModel}
                      placeholder="default"
                      onChange={(e) => updateSetting('kanbanStrictVerifyModel', e.target.value)}
                      className="w-full font-mono text-sm"
                      data-testid="strict-verify-model"
                    />
                    <p className="text-xs text-muted-foreground">
                      Optional model id passed to the provider (e.g. a stronger judge model). Leave
                      blank for the provider&apos;s default.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Transcript characters</label>
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={500}
                        max={24000}
                        step={500}
                        value={kanbanStrictVerifyChars}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10)
                          if (!isNaN(val) && val >= 500 && val <= 24000) {
                            updateSetting('kanbanStrictVerifyChars', val)
                          }
                        }}
                        className="w-24 font-mono text-sm"
                        data-testid="strict-verify-chars"
                      />
                      <span className="text-xs text-muted-foreground">characters (500–24000)</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      How many trailing characters of the session to send. The end of a session is
                      where completion signals live.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Confidence threshold</label>
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={kanbanStrictVerifyConfidenceThreshold}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value)
                          if (!isNaN(val) && val >= 0 && val <= 1) {
                            updateSetting('kanbanStrictVerifyConfidenceThreshold', val)
                          }
                        }}
                        className="w-24 font-mono text-sm"
                        data-testid="strict-verify-confidence-threshold"
                      />
                      <span className="text-xs text-muted-foreground">0–1 (default 0.6)</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      A &quot;complete&quot; verdict is only trusted at or above this confidence.
                      Higher = stricter (more tickets bounced back to In Progress).
                    </p>
                  </div>

                  {/* Reviewer system prompt — editable, with reset-to-default. */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-sm font-medium">Reviewer prompt</label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          updateSetting('kanbanStrictVerifyPrompt', DEFAULT_STRICT_VERIFY_PROMPT)
                        }
                        disabled={kanbanStrictVerifyPrompt === DEFAULT_STRICT_VERIFY_PROMPT}
                        data-testid="strict-verify-prompt-reset"
                      >
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        Reset to default
                      </Button>
                    </div>
                    <Textarea
                      value={kanbanStrictVerifyPrompt}
                      onChange={(e) => updateSetting('kanbanStrictVerifyPrompt', e.target.value)}
                      rows={10}
                      spellCheck={false}
                      className="w-full font-mono text-xs leading-relaxed"
                      data-testid="strict-verify-prompt"
                    />
                    <p className="text-xs text-muted-foreground">
                      The system prompt injected ahead of the transcript. Edit to tune what counts as
                      done. It <strong>must</strong> still ask for the JSON verdict (
                      <code>complete</code>, <code>needsInput</code>, <code>confidence</code>,{' '}
                      <code>reason</code>) or the Reviewer can&apos;t be parsed.
                    </p>
                  </div>

                  {/* Connection test — prove the chosen provider + model actually answer. */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Test connection</label>
                    <div className="flex items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleTestStrictVerifyProvider}
                        disabled={verifyTest.status === 'running'}
                        data-testid="strict-verify-test"
                      >
                        {verifyTest.status === 'running' ? (
                          <>
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            Testing…
                          </>
                        ) : (
                          'Run test'
                        )}
                      </Button>
                      {verifyTest.status === 'ok' && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-500">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {verifyTest.message}
                        </span>
                      )}
                      {verifyTest.status === 'fail' && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-500">
                          <XCircle className="h-3.5 w-3.5" />
                          {verifyTest.message}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Runs the Reviewer against a sample transcript using the provider, model, and
                      prompt above. Confirms the CLI is installed, the model id is valid, and the call
                      succeeds — no ticket is touched.
                    </p>
                  </div>

                  {/* ── Recover stuck In Progress tickets ──────────────────────────── */}
                  <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <label className="text-sm font-medium">Recover stuck In Progress tickets</label>
                        <p className="text-xs text-muted-foreground">
                          The reverse of the frozen check. After a ticket is bounced back to{' '}
                          <strong>In Progress</strong> as &quot;Not done&quot;, watch its session: if it
                          goes <em>frozen</em> (stopped emitting) while still stuck, the bounce was
                          likely premature, so re-promote it to <strong>Review</strong> once for a fresh
                          judgment. If it still isn&apos;t done it&apos;s left in In Progress with a
                          &quot;Re-checked&quot; label (max 1 retry, so no loop).
                        </p>
                      </div>
                      <button
                        role="switch"
                        aria-checked={kanbanInProgressRescueEnabled}
                        onClick={() =>
                          updateSetting(
                            'kanbanInProgressRescueEnabled',
                            !kanbanInProgressRescueEnabled
                          )
                        }
                        className={cn(
                          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                          kanbanInProgressRescueEnabled ? 'bg-primary' : 'bg-muted'
                        )}
                        data-testid="strict-verify-rescue-toggle"
                      >
                        <span
                          className={cn(
                            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                            kanbanInProgressRescueEnabled ? 'translate-x-4' : 'translate-x-0'
                          )}
                        />
                      </button>
                    </div>
                  </div>

                  {/* ── Queue prompts (claude-code-cli) ────────────────────────────── */}
                  <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <label className="text-sm font-medium">Queue prompts (Claude CLI)</label>
                        <p className="text-xs text-muted-foreground">
                          <strong>Claude Code CLI tickets only.</strong> Follow-ups you send while a
                          ticket is still working are <em>queued</em> instead of racing the running
                          turn. The next queued prompt is entered automatically only once the ticket
                          reaches <strong>Review</strong> and is <strong>verified complete</strong> by
                          the gates above — so each prompt runs in order, one finished-and-verified
                          step at a time. Manage the queue (count + remove) from the ticket&apos;s
                          detail view. Auto-disabled while Strict Verify is off.
                        </p>
                      </div>
                      <button
                        role="switch"
                        aria-checked={kanbanQueuePromptsEnabled}
                        onClick={() =>
                          updateSetting('kanbanQueuePromptsEnabled', !kanbanQueuePromptsEnabled)
                        }
                        className={cn(
                          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                          kanbanQueuePromptsEnabled ? 'bg-primary' : 'bg-muted'
                        )}
                        data-testid="kanban-queue-prompts-toggle"
                      >
                        <span
                          className={cn(
                            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                            kanbanQueuePromptsEnabled ? 'translate-x-4' : 'translate-x-0'
                          )}
                        />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Kanban — Iterate Loop (per-ticket review↔fix lifecycle callbacks) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">Iterate Loop by default</label>
            <p className="text-xs text-muted-foreground">
              Make the review↔fix loop actually iterate. When <strong>Strict Verify</strong> bounces
              a Review ticket back to In Progress, re-prompt the agent with <em>why</em> it failed
              (the reviewer&apos;s reason) so it fixes the work and tries again — up to a max number
              of rounds. At the cap the ticket is left <strong>stuck in Review</strong> (never
              auto-advanced) and the <code>stuck_review</code> notification fires. This is the
              default seeded onto new tickets; each ticket owns its own loop config in its detail
              view.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={kanbanIterateLoopEnabled}
            onClick={() => updateSetting('kanbanIterateLoopEnabled', !kanbanIterateLoopEnabled)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              kanbanIterateLoopEnabled ? 'bg-primary' : 'bg-muted'
            )}
            data-testid="iterate-loop-toggle"
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                kanbanIterateLoopEnabled ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>

        {kanbanIterateLoopEnabled && (
          <div className="ml-2 space-y-5 border-l-2 border-border pl-4">
            {/* Max iterations — the loop-breaker. */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Max iterations</label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={kanbanIterateLoopMaxIterations}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val >= 1 && val <= 20) {
                      updateSetting('kanbanIterateLoopMaxIterations', val)
                    }
                  }}
                  className="w-20 font-mono text-sm"
                  data-testid="iterate-loop-max"
                />
                <span className="text-xs text-muted-foreground">rounds (1-20)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                How many times a ticket may bounce Review → In Progress before it&apos;s left stuck
                in Review for you. Counts per session.
              </p>
            </div>

            {/* Fix prompt template — editable, with reset-to-default. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium">Fix prompt</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    updateSetting('kanbanIterateLoopFixPromptTemplate', DEFAULT_FIX_PROMPT_TEMPLATE)
                  }
                  disabled={kanbanIterateLoopFixPromptTemplate === DEFAULT_FIX_PROMPT_TEMPLATE}
                  data-testid="iterate-loop-prompt-reset"
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reset to default
                </Button>
              </div>
              <Textarea
                value={kanbanIterateLoopFixPromptTemplate}
                onChange={(e) =>
                  updateSetting('kanbanIterateLoopFixPromptTemplate', e.target.value)
                }
                rows={5}
                spellCheck={false}
                className="w-full font-mono text-xs leading-relaxed"
                data-testid="iterate-loop-prompt"
              />
              <p className="text-xs text-muted-foreground">
                Sent to the agent on each bounce. Use <code>{'{{reason}}'}</code> where the
                reviewer&apos;s reason should go — if you omit it the reason is appended.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Kanban — Condition Gate (two-stage review): Strict Verify + a routing LLM */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">Condition Gate (two-stage review)</label>
            <p className="text-xs text-muted-foreground">
              Seed the review <strong>ticket</strong> as a two-stage gate. Stage 1 is your Strict
              Verify Reviewer (&quot;did the agent finish?&quot;); once it passes, a second LLM reads
              the review&apos;s findings and routes <strong>pass</strong> (leave in Review for you) /{' '}
              <strong>fix</strong> (open a fix-loop round — an agent CRUDs a fresh{' '}
              <code>fix → review-plan → review</code> triple in the same worktree via the Hive CLI) /{' '}
              <strong>needs-human</strong> (leave in Review + a <code>question</code> notification).
              Applies to new <code>review</code> drafts. Requires <strong>Build</strong> mode. Off by
              default.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={kanbanConditionGateEnabled}
            onClick={() =>
              updateSetting('kanbanConditionGateEnabled', !kanbanConditionGateEnabled)
            }
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              kanbanConditionGateEnabled ? 'bg-primary' : 'bg-muted'
            )}
            data-testid="condition-gate-toggle"
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                kanbanConditionGateEnabled ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>

        {kanbanConditionGateEnabled && (
          <div className="ml-2 space-y-5 border-l-2 border-border pl-4">
            {/* Gate matcher — which `review` drafts arm the gate (dynamic target). */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Gate matcher</label>
              <select
                value={kanbanConditionGateMatchMode}
                onChange={(e) =>
                  updateSetting(
                    'kanbanConditionGateMatchMode',
                    e.target.value as typeof kanbanConditionGateMatchMode
                  )
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="condition-gate-match-mode"
              >
                <option value="both">Draft-key or description (default)</option>
                <option value="key">Draft-key only</option>
                <option value="word">Description only</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Which new drafts get seeded as a gate. <strong>Draft-key</strong> matches the
                draft&apos;s key (e.g. <code>review</code>, <code>review-r1</code>);{' '}
                <strong>description</strong> matches its text (for drafts with a generic key).
              </p>

              {kanbanConditionGateMatchMode !== 'word' && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      Draft-key pattern (regex)
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateSetting(
                          'kanbanConditionGateKeyPattern',
                          DEFAULT_CONDITION_GATE_KEY_PATTERN
                        )
                      }
                      disabled={kanbanConditionGateKeyPattern === DEFAULT_CONDITION_GATE_KEY_PATTERN}
                      data-testid="condition-gate-key-pattern-reset"
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      Reset
                    </Button>
                  </div>
                  <Input
                    type="text"
                    value={kanbanConditionGateKeyPattern}
                    placeholder={DEFAULT_CONDITION_GATE_KEY_PATTERN}
                    onChange={(e) =>
                      updateSetting('kanbanConditionGateKeyPattern', e.target.value)
                    }
                    className="w-full font-mono text-xs"
                    data-testid="condition-gate-key-pattern"
                  />
                </div>
              )}

              {kanbanConditionGateMatchMode !== 'key' && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      Description pattern (regex)
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateSetting(
                          'kanbanConditionGateWordPattern',
                          DEFAULT_CONDITION_GATE_WORD_PATTERN
                        )
                      }
                      disabled={
                        kanbanConditionGateWordPattern === DEFAULT_CONDITION_GATE_WORD_PATTERN
                      }
                      data-testid="condition-gate-word-pattern-reset"
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      Reset
                    </Button>
                  </div>
                  <Input
                    type="text"
                    value={kanbanConditionGateWordPattern}
                    placeholder={DEFAULT_CONDITION_GATE_WORD_PATTERN}
                    onChange={(e) =>
                      updateSetting('kanbanConditionGateWordPattern', e.target.value)
                    }
                    className="w-full font-mono text-xs"
                    data-testid="condition-gate-word-pattern"
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Case-insensitive. An invalid regex falls back to the default so seeding still
                works.
              </p>
            </div>

            {/* Max rounds — the fix-loop breaker for the condition gate. */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Max fix rounds</label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={kanbanConditionGateMaxRounds}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val >= 1 && val <= 20) {
                      updateSetting('kanbanConditionGateMaxRounds', val)
                    }
                  }}
                  className="w-20 font-mono text-sm"
                  data-testid="condition-gate-max"
                />
                <span className="text-xs text-muted-foreground">rounds (1–20, default 3)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                How many <strong>fix</strong> loops may run before a review is left blocked in
                Review for you. The round is read from the ticket title (
                <code>(round &#123;R&#125;)</code>).
              </p>
            </div>

            {/* Stage-2 routing provider. */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Routing AI provider</label>
              <select
                value={kanbanConditionGateProvider}
                onChange={(e) =>
                  updateSetting(
                    'kanbanConditionGateProvider',
                    e.target.value as typeof kanbanConditionGateProvider
                  )
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="condition-gate-provider"
              >
                {COMPLETION_CHECK_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>
                    {COMPLETION_PROVIDER_LABELS[provider]}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Which CLI reads the review&apos;s findings and picks the branch. Defaults to Claude
                Code CLI.
              </p>
            </div>

            {/* Stage-2 model override. */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Model</label>
              <Input
                type="text"
                value={kanbanConditionGateModel}
                placeholder="default"
                onChange={(e) => updateSetting('kanbanConditionGateModel', e.target.value)}
                className="w-full font-mono text-sm"
                data-testid="condition-gate-model"
              />
              <p className="text-xs text-muted-foreground">
                Optional model id passed to the routing provider. Leave blank for the
                provider&apos;s default.
              </p>
            </div>

            {/* Auto-Done on pass — off by default (the ticket waits in Review for you). */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="text-sm font-medium">Auto-advance to Done on a pass</label>
                <p className="text-xs text-muted-foreground">
                  When a <strong>pass</strong> verdict lands on a chain ticket, advance it to Done so
                  the next ticket auto-starts, instead of leaving it in Review for you. Off by
                  default.
                </p>
              </div>
              <button
                role="switch"
                aria-checked={kanbanConditionGateAutoDone}
                onClick={() =>
                  updateSetting('kanbanConditionGateAutoDone', !kanbanConditionGateAutoDone)
                }
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                  kanbanConditionGateAutoDone ? 'bg-primary' : 'bg-muted'
                )}
                data-testid="condition-gate-auto-done"
              >
                <span
                  className={cn(
                    'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                    kanbanConditionGateAutoDone ? 'translate-x-4' : 'translate-x-0'
                  )}
                />
              </button>
            </div>

            {/* Stage-2 routing prompt — editable, with reset-to-default. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium">Routing prompt</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    updateSetting('kanbanConditionGatePrompt', DEFAULT_CONDITION_GATE_PROMPT)
                  }
                  disabled={kanbanConditionGatePrompt === DEFAULT_CONDITION_GATE_PROMPT}
                  data-testid="condition-gate-prompt-reset"
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reset to default
                </Button>
              </div>
              <Textarea
                value={kanbanConditionGatePrompt}
                onChange={(e) => updateSetting('kanbanConditionGatePrompt', e.target.value)}
                rows={10}
                spellCheck={false}
                className="w-full font-mono text-xs leading-relaxed"
                data-testid="condition-gate-prompt"
              />
              <p className="text-xs text-muted-foreground">
                The system prompt for the Stage-2 router. It <strong>must</strong> still ask for the
                JSON verdict (<code>verdict</code>, <code>reason</code>, <code>fixes</code>) or the
                gate can&apos;t be parsed.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Kanban — Auto approve Review */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">Auto-approve Review by default</label>
            <p className="text-xs text-muted-foreground">
              The real switch lives <strong>per ticket</strong> — each ticket has its own
              &quot;Auto-approve Review&quot; checkbox in its detail view. This setting is just the
              default: new tickets get that checkbox pre-set to this value. Changing it here only
              affects future tickets, never existing ones. When a ticket&apos;s checkbox is on and
              it settles in Review, it auto-commits; if another ticket depends on it (a chain) it
              advances to Done so the next ticket auto-starts (using its own configured worktree).
              The last ticket in a chain — or a standalone ticket — stays in Review for you to PR
              &amp; merge. When <strong>Strict Verify</strong> is on, this runs only after a ticket
              is verified complete (the frozen check + Watcher pass first).
            </p>
          </div>
          <button
            role="switch"
            aria-checked={kanbanAutoApproveReview}
            onClick={() => updateSetting('kanbanAutoApproveReview', !kanbanAutoApproveReview)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              kanbanAutoApproveReview ? 'bg-primary' : 'bg-muted'
            )}
            data-testid="kanban-auto-approve-review-toggle"
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                kanbanAutoApproveReview ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>

        {/* Global behavior — applies to ANY ticket whose own checkbox is on,
            regardless of the default above. Collapsed with the default toggle for parity
            with the Strict Verify block. */}
        {kanbanAutoApproveReview && (
          <div className="ml-2 space-y-3 border-l-2 border-border pl-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Auto approve after</label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={kanbanAutoApproveDelaySeconds}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val >= 0 && val <= 600) {
                      updateSetting('kanbanAutoApproveDelaySeconds', val)
                    }
                  }}
                  className="w-20 font-mono text-sm"
                  data-testid="kanban-auto-approve-delay"
                />
                <span className="text-xs text-muted-foreground">seconds (0-600)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Applies to every ticket that has Auto-approve Review on. This is the trigger for
                everything below — nothing happens until it fires. The ticket must sit idle in
                Review this long before the series runs (auto-commit, then advance). The timer
                resets if the session resumes working, so transient completion (multi-turn agents,
                queued follow-ups, app relaunch) won't fire prematurely.
              </p>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="text-sm font-medium">Auto commit before advancing</label>
                <p className="text-xs text-muted-foreground">
                  Runs after the wait above fires: stage and commit the ticket worktree's changes.
                  Each chain step is committed before it advances.
                </p>
              </div>
              <button
                role="switch"
                aria-checked={kanbanAutoCommitOnReview}
                onClick={() => updateSetting('kanbanAutoCommitOnReview', !kanbanAutoCommitOnReview)}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                  kanbanAutoCommitOnReview ? 'bg-primary' : 'bg-muted'
                )}
                data-testid="kanban-auto-commit-on-review-toggle"
              >
                <span
                  className={cn(
                    'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                    kanbanAutoCommitOnReview ? 'translate-x-4' : 'translate-x-0'
                  )}
                />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Vim mode */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Vim mode</label>
          <p className="text-xs text-muted-foreground">
            Enable vim-style keyboard navigation with hints, hjkl scrolling, and mode switching
          </p>
        </div>
        <button
          role="switch"
          aria-checked={vimModeEnabled}
          onClick={() => updateSetting('vimModeEnabled', !vimModeEnabled)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            vimModeEnabled ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="vim-mode-enabled-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              vimModeEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Keep computer awake during sessions */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Keep computer awake during sessions</label>
          <p className="text-xs text-muted-foreground">
            Prevent your computer from sleeping while any worktree has an AI session actively
            running.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={keepAwakeEnabled}
          onClick={() => updateSetting('keepAwakeEnabled', !keepAwakeEnabled)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            keepAwakeEnabled ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="keep-awake-enabled-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              keepAwakeEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Merge conflict mode */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Merge conflict mode</label>
        <p className="text-xs text-muted-foreground">
          Choose which mode to use when fixing merge conflicts with AI
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('mergeConflictMode', 'build')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              mergeConflictMode === 'build'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="merge-conflict-mode-build"
          >
            Build
          </button>
          <button
            onClick={() => updateSetting('mergeConflictMode', 'plan')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              mergeConflictMode === 'plan'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="merge-conflict-mode-plan"
          >
            Plan
          </button>
          <button
            onClick={() => updateSetting('mergeConflictMode', 'always-ask')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              mergeConflictMode === 'always-ask'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="merge-conflict-mode-always-ask"
          >
            Always Ask
          </button>
        </div>
      </div>

      {/* Auto-resolve conflict prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Auto-resolve conflict prompt</label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => {
              setAutoResolvePromptDraft(DEFAULT_AUTO_RESOLVE_CONFLICT_PROMPT)
              updateSetting('autoResolveConflictPrompt', DEFAULT_AUTO_RESOLVE_CONFLICT_PROMPT)
            }}
            data-testid="auto-resolve-prompt-reset"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to default
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Sent to the ticket&apos;s Claude Code terminal when you click “Auto Resolve Conflict &amp;
          Merge” after a PR merge conflict. Placeholders{' '}
          <code className="rounded bg-muted px-1 py-0.5">{'{prNumber}'}</code>,{' '}
          <code className="rounded bg-muted px-1 py-0.5">{'{baseBranch}'}</code> and{' '}
          <code className="rounded bg-muted px-1 py-0.5">{'{featureBranch}'}</code> are filled in
          automatically.
        </p>
        <Textarea
          value={autoResolvePromptDraft}
          onChange={(e) => setAutoResolvePromptDraft(e.target.value)}
          onBlur={() => updateSetting('autoResolveConflictPrompt', autoResolvePromptDraft)}
          placeholder="Prompt for auto-resolving merge conflicts…"
          rows={10}
          className="font-mono text-xs resize-y"
          data-testid="auto-resolve-prompt-input"
        />
      </div>

      {/* Protected branches */}
      <div className="space-y-1">
        <label className="text-sm font-medium">Protected branches</label>
        <p className="text-xs text-muted-foreground">
          Comma-separated branch names. When a ticket moves to Done, Hive won&apos;t suggest merging
          into any branch listed here — it just moves the ticket to Done. Leave empty to disable.
        </p>
        <Input
          value={protectedBranchesDraft}
          onChange={(e) => setProtectedBranchesDraft(e.target.value)}
          onBlur={() => updateSetting('protectedBranches', protectedBranchesDraft)}
          placeholder="main, master, develop, staging"
          className="h-8 text-sm"
          data-testid="protected-branches-input"
        />
      </div>

      {/* Auto-approve plan mode */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">Auto-approve plan mode</label>
            <p className="text-xs text-muted-foreground">
              When a Claude Code CLI session finishes planning, Hive can auto-pick the approval
              option whose label contains the match text below. Turn it on or off per ticket — this
              switch only sets the default for newly started tickets.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autoApprovePlanEnabled}
            onClick={() => updateSetting('autoApprovePlanEnabled', !autoApprovePlanEnabled)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              autoApprovePlanEnabled ? 'bg-primary' : 'bg-muted'
            )}
            data-testid="auto-approve-plan-toggle"
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                autoApprovePlanEnabled ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Approval option match text
          </label>
          <Input
            value={autoApprovePlanDraft}
            onChange={(e) => setAutoApprovePlanDraft(e.target.value)}
            onBlur={() => updateSetting('autoApprovePlanMatchText', autoApprovePlanDraft)}
            placeholder="e.g. clear context"
            className="h-8 text-sm"
            data-testid="auto-approve-plan-match-input"
          />
          <p className="text-xs text-muted-foreground">
            Used for every ticket that has auto-approve on. Case-insensitive; first matching option
            wins. Leave blank to disable.
          </p>
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs"
            data-testid="auto-approve-plan-warning"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div className="space-y-1.5 text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  Pick a phrase unique to one option.
                </span>{' '}
                The match is a case-insensitive substring and the{' '}
                <span className="font-medium">first</span> matching option wins, so a loose phrase
                can select the wrong option. Common ExitPlanMode options and a safe match for each:
              </p>
              <ul className="space-y-0.5">
                <li>
                  Yes, clear context … →{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-foreground">clear context</code>
                </li>
                <li>
                  Yes, and bypass permissions →{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                    yes, and bypass
                  </code>
                </li>
                <li>
                  Yes, manually approve edits →{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                    manually approve
                  </code>
                </li>
                <li>
                  No, refine with plan … →{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                    refine with plan
                  </code>
                </li>
              </ul>
              <p>
                Avoid{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                  bypass permissions
                </code>{' '}
                — it appears in both the &ldquo;clear context&rdquo; and &ldquo;bypass
                permissions&rdquo; options, so it would pick the first (clear context). Labels vary
                by Claude Code version — re-check after upgrading.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Inject worktree context */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">Inject worktree context</label>
            <p className="text-xs text-muted-foreground">
              For Claude Code CLI tickets, hold the agent until the worktree&apos;s setup script
              finishes, then inject the live context (port, dev URL, branch, notes, setup output)
              into the first prompt. Turn it on or off per ticket — this switch only sets the
              default for newly started tickets.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={injectWorktreeContextEnabled}
            onClick={() =>
              updateSetting('injectWorktreeContextEnabled', !injectWorktreeContextEnabled)
            }
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              injectWorktreeContextEnabled ? 'bg-primary' : 'bg-muted'
            )}
            data-testid="inject-worktree-context-toggle"
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                injectWorktreeContextEnabled ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">Context template</label>
            <button
              type="button"
              onClick={() => {
                setWorktreeContextDraft(DEFAULT_CONTEXT_TEMPLATE)
                updateSetting('worktreeContextTemplate', DEFAULT_CONTEXT_TEMPLATE)
              }}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              data-testid="worktree-context-reset"
            >
              Reset to default
            </button>
          </div>
          <Textarea
            value={worktreeContextDraft}
            onChange={(e) => setWorktreeContextDraft(e.target.value)}
            onBlur={() => updateSetting('worktreeContextTemplate', worktreeContextDraft)}
            rows={10}
            className="font-mono text-xs"
            data-testid="worktree-context-template-input"
          />
          <p className="text-xs text-muted-foreground">
            Default template for new tickets; each ticket can override it in the worktree picker.
            Tokens:{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{PORT}}'}</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{DEV_URL}}'}</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{BRANCH}}'}</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{BASE_BRANCH}}'}</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{WORKTREE_PATH}}'}</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">
              {'{{WORKTREE_CONTEXT}}'}
            </code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{SETUP_OUTPUT}}'}</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{ENV}}'}</code>{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">
              {'{{WORKTREE_SUMMARY}}'}
            </code>
            . Unknown or empty tokens render as blank.{' '}
            <span className="text-foreground">{'{{WORKTREE_SUMMARY}}'}</span> is an AI-generated
            project orientation — Claude Code CLI inspects the worktree once, then the result is
            cached and reused by every ticket that shares it. It costs tokens, so it only runs when
            you include that token in the template.
          </p>
        </div>
      </div>

      {/* Tips */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Show tips</label>
          <p className="text-xs text-muted-foreground">
            Show helpful tips when discovering new features
          </p>
        </div>
        <button
          role="switch"
          aria-checked={tipsEnabled}
          onClick={() => updateSetting('tipsEnabled', !tipsEnabled)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            tipsEnabled ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="tips-enabled-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              tipsEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Model icons */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Model icons</label>
          <p className="text-xs text-muted-foreground">
            Show the model icon (Claude, OpenAI) next to the worktree status
          </p>
        </div>
        <button
          role="switch"
          aria-checked={showModelIcons}
          onClick={() => updateSetting('showModelIcons', !showModelIcons)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            showModelIcons ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="show-model-icons-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              showModelIcons ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Show model provider */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Show model provider</label>
          <p className="text-xs text-muted-foreground">
            Display the provider name (e.g. ANTHROPIC) next to the model in the selector pill
          </p>
        </div>
        <button
          role="switch"
          aria-checked={showModelProvider}
          onClick={() => updateSetting('showModelProvider', !showModelProvider)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            showModelProvider ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="show-model-provider-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              showModelProvider ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Usage indicator */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Usage indicator</label>
        <p className="text-xs text-muted-foreground">
          Choose how usage is displayed. Current agent auto-detects from the active session.
          Specific providers lets you pin which usage bars always show.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('usageIndicatorMode', 'current-agent')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              usageIndicatorMode === 'current-agent'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="usage-indicator-mode-current-agent"
          >
            Current agent
          </button>
          <button
            onClick={() => updateSetting('usageIndicatorMode', 'specific-providers')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              usageIndicatorMode === 'specific-providers'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="usage-indicator-mode-specific-providers"
          >
            Specific providers
          </button>
        </div>
        {usageIndicatorMode === 'specific-providers' && (
          <div className="ml-2 mt-2 space-y-2">
            <button
              role="checkbox"
              aria-checked={usageIndicatorProviders.includes('anthropic')}
              onClick={() => toggleProvider('anthropic')}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border transition-colors w-full',
                usageIndicatorProviders.includes('anthropic')
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
              )}
              data-testid="usage-provider-anthropic"
            >
              <img src={claudeIcon} alt="Claude" className="h-3.5 w-3.5" />
              Claude
            </button>
            <button
              role="checkbox"
              aria-checked={usageIndicatorProviders.includes('openai')}
              onClick={() => toggleProvider('openai')}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border transition-colors w-full',
                usageIndicatorProviders.includes('openai')
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
              )}
              data-testid="usage-provider-openai"
            >
              <img src={openaiIcon} alt="OpenAI" className="h-3.5 w-3.5" />
              OpenAI
            </button>
            {usageIndicatorProviders.length === 0 && (
              <p className="text-xs text-muted-foreground/70 italic">
                Select at least one provider, or switch to Current agent mode.
              </p>
            )}
          </div>
        )}
        <SavedAccountsList />
      </div>

      {/* Default Agent SDK */}
      <div className="space-y-2">
        <label className="text-sm font-medium">AI Provider</label>
        <p className="text-xs text-muted-foreground">
          Choose which AI coding agent to use for new sessions. Existing sessions keep their
          original provider.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'opencode')}
            disabled={!opencodeAvailable}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              defaultAgentSdk === 'opencode'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-opencode"
            title={!opencodeAvailable ? 'OpenCode is not currently available' : undefined}
          >
            OpenCode
          </button>
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'claude-code')}
            disabled={!claudeAvailable}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              defaultAgentSdk === 'claude-code'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-claude-code"
            title={!claudeAvailable ? 'Claude Code is not currently available' : undefined}
          >
            Claude Code
          </button>
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'codex')}
            disabled={!codexAvailable}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              defaultAgentSdk === 'codex'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-codex"
            title={!codexAvailable ? 'Codex is not currently available' : undefined}
          >
            Codex
          </button>
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'terminal')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              defaultAgentSdk === 'terminal'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-terminal"
          >
            Terminal
          </button>
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'claude-code-cli')}
            disabled={!claudeCliAvailable}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              defaultAgentSdk === 'claude-code-cli'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-claude-code-cli"
            title={!claudeCliAvailable ? 'Claude Code CLI is not currently available' : undefined}
          >
            Claude Code (CLI)
          </button>
        </div>
        {availableAgentSdks &&
          (!opencodeAvailable || !claudeAvailable || !claudeCliAvailable || !codexAvailable) && (
            <p className="text-xs text-muted-foreground/70 italic">
              Unavailable providers are disabled until their CLI is installed and launchable from
              Hive.
            </p>
          )}
        {defaultAgentSdk === 'terminal' && (
          <p className="text-xs text-muted-foreground/70 italic">
            Opens a terminal window. Run any AI tool manually (claude, aider, cursor, etc.)
          </p>
        )}
      </div>

      {/* Strip @ from file mentions */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Strip @ from file mentions</label>
          <p className="text-xs text-muted-foreground">
            Remove the @ symbol from file references inserted via the file picker before sending
          </p>
        </div>
        <button
          role="switch"
          aria-checked={stripAtMentions}
          onClick={() => updateSetting('stripAtMentions', !stripAtMentions)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            stripAtMentions ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="strip-at-mentions-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              stripAtMentions ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Branch naming */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Branch Naming</label>
        <p className="text-xs text-muted-foreground">
          Choose the naming theme for auto-generated worktree branches
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('breedType', 'dogs')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              breedType === 'dogs'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="breed-type-dogs"
          >
            Dogs
          </button>
          <button
            onClick={() => updateSetting('breedType', 'cats')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              breedType === 'cats'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="breed-type-cats"
          >
            Cats
          </button>
        </div>
      </div>

      {/* Restart Hive */}
      {canRelaunch && (
        <div className="pt-4 border-t">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={restarting} data-testid="restart-app">
                <RotateCw className={cn('h-3.5 w-3.5 mr-1.5', restarting && 'animate-spin')} />
                {restarting ? 'Restarting…' : 'Restart Hive'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Restart Hive?</AlertDialogTitle>
                <AlertDialogDescription>
                  Hive will quit and reopen. Any running agent sessions in this window will be
                  interrupted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="restart-app-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleRestart} data-testid="restart-app-confirm">
                  Restart
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <p className="text-xs text-muted-foreground mt-1">
            Quit and reopen Hive. Useful after changing settings that need a fresh start.
          </p>
        </div>
      )}

      {/* Reset to defaults */}
      <div className="pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetAll}
          className="text-destructive hover:text-destructive"
          data-testid="reset-all-settings"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          Reset All to Defaults
        </Button>
        <p className="text-xs text-muted-foreground mt-1">
          This will reset all settings, theme, and keyboard shortcuts to their defaults.
        </p>
      </div>
    </div>
  )
}
