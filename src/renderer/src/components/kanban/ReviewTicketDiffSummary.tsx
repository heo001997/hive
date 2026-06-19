import { useEffect, useState, type JSX } from 'react'
import { Check, Pencil, X } from 'lucide-react'

export interface ReviewTicketDiffFile {
  relativePath: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}

interface ReviewTicketDiffSummaryProps {
  baseBranch: string | null
  files: ReviewTicketDiffFile[]
  loading: boolean
  error: string | null
  /** When provided, the base branch becomes editable; called with the new branch on save. */
  onBaseBranchChange?: (newBaseBranch: string) => void | Promise<void>
}

export function ReviewTicketDiffSummary({
  baseBranch,
  files,
  loading,
  error,
  onBaseBranchChange
}: ReviewTicketDiffSummaryProps): JSX.Element | null {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(baseBranch ?? '')
  const [isSaving, setIsSaving] = useState(false)

  // Keep the draft in sync when the resolved base branch changes externally.
  useEffect(() => {
    if (!isEditing) setDraft(baseBranch ?? '')
  }, [baseBranch, isEditing])

  const editable = !!onBaseBranchChange

  const handleSave = async (): Promise<void> => {
    const next = draft.trim()
    if (!next || next === baseBranch) {
      setIsEditing(false)
      setDraft(baseBranch ?? '')
      return
    }
    setIsSaving(true)
    try {
      await onBaseBranchChange?.(next)
      setIsEditing(false)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = (): void => {
    setIsEditing(false)
    setDraft(baseBranch ?? '')
  }

  if (!baseBranch && !loading && !error) return null

  return (
    <section
      className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2 min-h-0 flex flex-col"
      data-testid="review-diff-summary"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Changed Files
          </h3>
          {isEditing ? (
            <div className="mt-0.5 flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Against</span>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleSave()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    handleCancel()
                  }
                }}
                disabled={isSaving}
                placeholder="base branch"
                className="h-5 w-40 rounded border border-input bg-background px-1 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                data-testid="review-diff-summary-base-input"
              />
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving}
                title="Save base branch"
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                data-testid="review-diff-summary-base-save"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isSaving}
                title="Cancel"
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                data-testid="review-diff-summary-base-cancel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            (baseBranch || editable) && (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                Against{' '}
                <span className="font-mono text-foreground">{baseBranch ?? 'base branch'}</span>
                {editable && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(baseBranch ?? '')
                      setIsEditing(true)
                    }}
                    title="Edit base branch"
                    className="text-muted-foreground hover:text-foreground"
                    data-testid="review-diff-summary-base-edit"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </p>
            )
          )}
        </div>
        {!loading && !error && (
          <span
            className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
            data-testid="review-diff-summary-count"
          >
            {files.length}
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading changed files...</p>
      ) : error ? (
        <p className="text-xs text-destructive" data-testid="review-diff-summary-error">
          {error}
        </p>
      ) : files.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No changes against <span className="font-mono">{baseBranch ?? 'base branch'}</span>.
        </p>
      ) : (
        <div
          className="space-y-1 overflow-y-auto pr-1 min-h-0 max-h-64"
          data-testid="review-diff-summary-scroll"
        >
          {files.map((file) => (
            <div
              key={file.relativePath}
              className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/30"
              data-testid="review-diff-summary-file"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                {file.relativePath}
              </span>
              {file.binary ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">binary</span>
              ) : (
                <span className="shrink-0 space-x-2 font-mono text-[11px]">
                  <span className="text-emerald-500">+{file.additions}</span>
                  <span className="text-rose-500">-{file.deletions}</span>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
