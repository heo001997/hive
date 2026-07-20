// Minimal shared palette + spacing. Dark-first to match Hive's desktop look.
export const colors = {
  bg: '#0b0b0f',
  card: '#16161d',
  cardAlt: '#1e1e28',
  border: '#2a2a36',
  text: '#f2f2f7',
  textMuted: '#9a9aa8',
  accent: '#7c8cff',
  accentText: '#ffffff',
  add: '#3fb950',
  del: '#f85149',
  danger: '#f85149',
  warn: '#e3b341'
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24
} as const
