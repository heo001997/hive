// ── Kanban column head colors ───────────────────────────────────────
// A column head's color is stored as a string: either a preset key
// (e.g. 'blue') or a custom hex string (e.g. '#ff5733'). 'none' (or an
// unknown value) renders the neutral default head.
//
// Preset Tailwind classes are written as literal strings so the JIT
// compiler picks them up; custom hex values render via inline style.

export type KanbanColumnColorKey =
  | 'none'
  | 'slate'
  | 'blue'
  | 'cyan'
  | 'indigo'
  | 'violet'
  | 'green'
  | 'amber'
  | 'orange'
  | 'rose'
  | 'pink'

export interface KanbanColumnColorClasses {
  /** Tinted background + border for the header container */
  header: string
  /** Text color for the column title */
  title: string
  /** Background + text for the ticket-count badge */
  badge: string
  /** Solid fill for the swatch dot in the picker */
  swatch: string
}

export const KANBAN_COLUMN_COLOR_PRESETS: Record<
  Exclude<KanbanColumnColorKey, 'none'>,
  KanbanColumnColorClasses
> = {
  slate: {
    header: 'bg-slate-500/10 border-slate-500/20',
    title: 'text-slate-600 dark:text-slate-300',
    badge: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    swatch: 'bg-slate-500'
  },
  blue: {
    header: 'bg-blue-500/10 border-blue-500/20',
    title: 'text-blue-600 dark:text-blue-400',
    badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
    swatch: 'bg-blue-500'
  },
  cyan: {
    header: 'bg-cyan-500/10 border-cyan-500/20',
    title: 'text-cyan-600 dark:text-cyan-400',
    badge: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
    swatch: 'bg-cyan-500'
  },
  indigo: {
    header: 'bg-indigo-500/10 border-indigo-500/20',
    title: 'text-indigo-600 dark:text-indigo-400',
    badge: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
    swatch: 'bg-indigo-500'
  },
  violet: {
    header: 'bg-violet-500/10 border-violet-500/20',
    title: 'text-violet-600 dark:text-violet-400',
    badge: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    swatch: 'bg-violet-500'
  },
  green: {
    header: 'bg-green-500/10 border-green-500/20',
    title: 'text-green-600 dark:text-green-400',
    badge: 'bg-green-500/15 text-green-700 dark:text-green-300',
    swatch: 'bg-green-500'
  },
  amber: {
    header: 'bg-amber-500/10 border-amber-500/20',
    title: 'text-amber-600 dark:text-amber-400',
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    swatch: 'bg-amber-500'
  },
  orange: {
    header: 'bg-orange-500/10 border-orange-500/20',
    title: 'text-orange-600 dark:text-orange-400',
    badge: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
    swatch: 'bg-orange-500'
  },
  rose: {
    header: 'bg-rose-500/10 border-rose-500/20',
    title: 'text-rose-600 dark:text-rose-400',
    badge: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    swatch: 'bg-rose-500'
  },
  pink: {
    header: 'bg-pink-500/10 border-pink-500/20',
    title: 'text-pink-600 dark:text-pink-400',
    badge: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',
    swatch: 'bg-pink-500'
  }
}

/** Swatch order shown in the picker grid. */
export const KANBAN_COLUMN_COLOR_ORDER: Array<Exclude<KanbanColumnColorKey, 'none'>> = [
  'slate',
  'blue',
  'cyan',
  'indigo',
  'violet',
  'green',
  'amber',
  'orange',
  'rose',
  'pink'
]

export const KANBAN_COLUMN_COLOR_LABELS: Record<KanbanColumnColorKey, string> = {
  none: 'None',
  slate: 'Slate',
  blue: 'Blue',
  cyan: 'Cyan',
  indigo: 'Indigo',
  violet: 'Violet',
  green: 'Green',
  amber: 'Amber',
  orange: 'Orange',
  rose: 'Rose',
  pink: 'Pink'
}

/**
 * Default head color per column, grounded in Kanban convention:
 * blue = queued, amber = active work (matches the In Progress Zap icon),
 * violet = review/QA gate, green = done/success.
 */
export const DEFAULT_KANBAN_COLUMN_COLORS: Record<string, string> = {
  todo: 'blue',
  in_progress: 'amber',
  review: 'violet',
  done: 'green'
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value.trim())
}

export interface ResolvedColumnColor {
  /** Preset class set, when the stored value is a known preset key. */
  preset: KanbanColumnColorClasses | null
  /** Normalized hex string, when the stored value is a custom hex. */
  customHex: string | null
  /** True when no color applies (neutral default head). */
  isNone: boolean
}

export function resolveColumnColor(value: string | undefined | null): ResolvedColumnColor {
  if (!value || value === 'none') return { preset: null, customHex: null, isNone: true }
  const preset = KANBAN_COLUMN_COLOR_PRESETS[value as Exclude<KanbanColumnColorKey, 'none'>]
  if (preset) return { preset, customHex: null, isNone: false }
  if (isHexColor(value)) return { preset: null, customHex: value.trim(), isNone: false }
  // Unknown value — fall back to the neutral default head.
  return { preset: null, customHex: null, isNone: true }
}

/** Resolve the stored color for a column, falling back to the convention default. */
export function columnColorValue(
  colors: Record<string, string> | undefined,
  column: string
): string {
  return colors?.[column] ?? DEFAULT_KANBAN_COLUMN_COLORS[column] ?? 'none'
}

/** Convert a #rgb / #rrggbb hex to an rgba() string at the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
