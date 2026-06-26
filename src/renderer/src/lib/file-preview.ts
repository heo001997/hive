import { IMAGE_MIME_TYPES } from '@shared/types/file-utils'

/** How a file is rendered inside the in-app preview. */
export type PreviewKind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'other'

// Extensions that `fileApi.readFile` can usefully show as plain text in a <pre>.
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties',
  'xml', 'html', 'htm', 'svg', 'css', 'scss', 'sass', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'php', 'pl', 'lua', 'r', 'dart', 'scala',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'dockerfile', 'gitignore', 'gradle', 'diff', 'patch'
])

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus'
}

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', mkv: 'video/x-matroska'
}

/** Lower-cased extension (no dot) of a path or file name; '' if none. */
export function extensionOf(nameOrPath: string): string {
  const base = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Decide how a file should be previewed, from its name/extension. */
export function classifyPreview(nameOrPath: string): PreviewKind {
  const ext = extensionOf(nameOrPath)
  if (`.${ext}` in IMAGE_MIME_TYPES) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext in AUDIO_MIME) return 'audio'
  if (ext in VIDEO_MIME) return 'video'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'other'
}

/**
 * Best-effort MIME type for building a `data:` URL from base64 bytes. Images and
 * PDFs/media are covered; anything else falls back to a generic binary type.
 */
export function mimeForPath(nameOrPath: string): string {
  const ext = extensionOf(nameOrPath)
  return (
    IMAGE_MIME_TYPES[`.${ext}`] ??
    (ext === 'pdf' ? 'application/pdf' : undefined) ??
    AUDIO_MIME[ext] ??
    VIDEO_MIME[ext] ??
    'application/octet-stream'
  )
}
