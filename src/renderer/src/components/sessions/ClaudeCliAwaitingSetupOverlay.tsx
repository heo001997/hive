import { AlertTriangle, Loader2 } from 'lucide-react'

interface ClaudeCliAwaitingSetupOverlayProps {
  state: 'awaiting' | 'blocked'
  error?: string
  onLaunchAnyway: () => void
}

export function ClaudeCliAwaitingSetupOverlay({
  state,
  error,
  onLaunchAnyway
}: ClaudeCliAwaitingSetupOverlayProps): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/75 px-6 text-center text-sm text-foreground backdrop-blur-[1px]"
      data-testid="claude-cli-awaiting-setup-overlay"
    >
      {state === 'awaiting' ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="font-medium">Waiting for setup…</span>
          <span className="max-w-md text-xs text-muted-foreground">
            Holding the agent until the worktree&apos;s setup script finishes, then injecting its
            context into the first prompt.
          </span>
        </>
      ) : (
        <>
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <span className="font-medium">Setup failed</span>
          {error && (
            <span
              className="max-w-md break-words text-xs text-muted-foreground"
              data-testid="claude-cli-awaiting-setup-error"
            >
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={onLaunchAnyway}
            className="mt-1 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
            data-testid="claude-cli-launch-anyway-btn"
          >
            Launch anyway
          </button>
        </>
      )}
    </div>
  )
}
