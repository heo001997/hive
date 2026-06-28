import { useId } from 'react'
import { cn } from '@/lib/utils'

interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  /** Upper bound for the y-axis. Defaults to the max value in the series. */
  max?: number
  className?: string
  /** Tailwind stroke colour class, e.g. "stroke-primary". */
  strokeClassName?: string
}

/**
 * Tiny dependency-free SVG sparkline (avoids pulling in a charting library).
 * Renders a polyline with a soft gradient area fill under it.
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  max,
  className,
  strokeClassName = 'stroke-primary'
}: SparklineProps): React.JSX.Element {
  const gradientId = useId()
  const hi = Math.max(max ?? Math.max(...values, 0), 1)
  const n = values.length

  if (n === 0) {
    return <svg width={width} height={height} className={className} aria-hidden />
  }

  const coords = values.map((v, i) => {
    const x = n === 1 ? width : (i / (n - 1)) * width
    const y = height - (Math.min(Math.max(v, 0), hi) / hi) * height
    return [x, y] as const
  })

  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('overflow-visible', className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} className={strokeClassName} stroke="none" />
      <polyline
        points={line}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={strokeClassName}
      />
    </svg>
  )
}
