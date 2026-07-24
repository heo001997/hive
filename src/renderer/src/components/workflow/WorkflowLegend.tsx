/** Shared status legend for the workflow surfaces. Semantic tokens only. */
const ITEMS: Array<{ label: string; color: string }> = [
  { label: 'Done', color: 'var(--chart-2)' },
  { label: 'Running', color: 'var(--primary)' },
  { label: 'Review / blocked', color: 'var(--chart-4)' },
  { label: 'To do', color: 'var(--muted-foreground)' }
]

export function WorkflowLegend(): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {ITEMS.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: item.color }}
            aria-hidden
          />
          {item.label}
        </span>
      ))}
    </div>
  )
}
