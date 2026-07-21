/**
 * Convert a ticket title into a safe git branch name.
 * Unlike canonicalizeBranchName (which takes 3 words for verbose session titles),
 * this uses more of the ticket title to stay recognizable.
 *
 * Important: this slug is also used as part of the worktree folder name.
 * Keep it filesystem-safe and short enough for downstream Windows paths
 * inside the worktree (for example repos with long backlog filenames).
 *
 * Lives in shared/ so both main and renderer processes can import it
 * (git-service.ts has Node.js deps that crash the renderer).
 */
export function canonicalizeTicketTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces and underscores → dashes
    .replace(/[^a-z0-9\-.]/g, '') // remove chars unsafe for worktree folder names
    .replace(/\.{2,}/g, '.') // collapse consecutive dots (git refs forbid '..')
    .replace(/-{2,}/g, '-') // collapse consecutive dashes
    .replace(/^[-.]+|[-.]+$/g, '') // strip leading/trailing dashes and dots (git refs forbid trailing '.')
    .slice(0, 32) // keep ticket-named worktrees under Windows path limits
    .replace(/\.lock$/, '') // git refs may not end with '.lock'
    .replace(/[-.]+$/, '') // strip trailing dashes/dots left after truncation / .lock removal
}

// ── Speckit-style branch-name candidates ────────────────────────────
// Ported from wellifiy-ror's `/speckit.git.feature` extension
// (.specify/extensions/git/scripts/bash/create-new-feature.sh): derive a
// concise action-noun short name, then offer it under a sequential (NNN-),
// timestamp (YYYYMMDD-HHMMSS-), or bare prefix. These are ADDITIONAL options
// in the worktree-creation picker — Hive's own derived name stays the default.

export type BranchNameCandidateKind = 'hive-default' | 'sequential' | 'timestamp' | 'short-name'

export interface BranchNameCandidate {
  kind: BranchNameCandidateKind
  /** Short label for the picker (e.g. "Sequential"). */
  label: string
  /** One-line note describing how the name was built. */
  hint: string
  /** The branch name itself. */
  value: string
}

// Stop words dropped when deriving a short name. Mirrors generate_branch_name()
// in create-new-feature.sh — includes common verbs (want/need/add/get/set) so
// the meaningful noun survives.
const BRANCH_STOP_WORDS = new Set([
  'i', 'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must',
  'shall', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'want',
  'need', 'add', 'get', 'set'
])

/** Lowercase, non-alphanumerics → dashes, collapse/trim dashes. Mirrors clean_branch_name(). */
function cleanBranchToken(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Derive a concise 2–4 word action-noun short name from a ticket title (and
 * optional description). Ports generate_branch_name(): drop stop words, keep
 * words ≥3 chars OR short acronyms that appear uppercase in the source
 * (API, JWT, AI…), take the first 3 meaningful words (4 if exactly four
 * survive). Falls back to the first 3 cleaned tokens when nothing survives.
 */
export function deriveBranchShortName(title: string, description?: string | null): string {
  const source = [title, description]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join(' ')
  const lowered = source.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  const meaningful: string[] = []
  for (const word of lowered.split(/\s+/)) {
    if (!word || BRANCH_STOP_WORDS.has(word)) continue
    if (word.length >= 3) {
      meaningful.push(word)
    } else {
      // Keep a short word only when it appears as an uppercase acronym in the
      // original source (e.g. "AI", "ML") — preserves technical terms.
      if (new RegExp(`\\b${word.toUpperCase()}\\b`).test(source)) meaningful.push(word)
    }
  }
  if (meaningful.length > 0) {
    const maxWords = meaningful.length === 4 ? 4 : 3
    return meaningful.slice(0, maxWords).join('-')
  }
  return cleanBranchToken(source).split('-').filter(Boolean).slice(0, 3).join('-')
}

/**
 * Highest existing sequential feature number + 1, scanning branch/worktree
 * names. Counts names matching `NNN-` (≥3 digits) but excludes timestamp names
 * (`YYYYMMDD-HHMMSS-`). Ports _extract_highest_number() / check_existing_branches().
 */
export function computeNextSequentialNumber(existingNames: Iterable<string>): number {
  let highest = 0
  for (const raw of existingNames) {
    const name = raw.replace(/^remotes\/[^/]+\//, '').replace(/^\*?\s*/, '')
    if (/^\d{8}-\d{6}-/.test(name)) continue // timestamp branch — not sequential
    const match = name.match(/^(\d{3,})-/)
    if (!match) continue
    const n = parseInt(match[1], 10)
    if (n > highest) highest = n
  }
  return highest + 1
}

/** Zero-padded 3-digit sequential prefix (7 → "007"). */
export function formatSequentialPrefix(n: number): string {
  return String(n).padStart(3, '0')
}

/** Timestamp prefix `YYYYMMDD-HHMMSS` from a Date (local time). */
export function formatTimestampPrefix(date: Date): string {
  const p = (v: number): string => String(v).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * Light git/filesystem-safe cleanup for a user-typed custom branch name. Unlike
 * canonicalizeTicketTitle this preserves case and allows a longer name (it's the
 * explicit escape hatch, akin to speckit's GIT_BRANCH_NAME), but still strips
 * characters that break git refs or the worktree folder name (spaces become
 * dashes; slashes and other unsafe chars are dropped).
 */
export function sanitizeCustomBranchName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.lock$/, '')
    .slice(0, 100)
    .replace(/[-.]+$/, '')
}

export interface GenerateBranchCandidatesOptions {
  title: string
  description?: string | null
  /** Existing branch + worktree names, for computing the next sequential number. */
  existingNames?: Iterable<string>
  /** Timestamp for the timestamp-prefixed candidate. */
  now: Date
  /** Hive's default derived name (canonicalizeTicketTitle) — the fallback path. */
  hiveDefault: string
}

/**
 * Build the branch-name candidates shown in the worktree-creation picker:
 * Hive's existing derived name (default/fallback) plus speckit-style sequential
 * (`NNN-<short>`), timestamp (`YYYYMMDD-HHMMSS-<short>`), and a bare short-name
 * option. De-duplicated by value; the user can still type a custom name to
 * bypass generation entirely.
 */
export function generateBranchNameCandidates(
  opts: GenerateBranchCandidatesOptions
): BranchNameCandidate[] {
  const shortName = deriveBranchShortName(opts.title, opts.description)
  const candidates: BranchNameCandidate[] = []

  if (opts.hiveDefault) {
    candidates.push({
      kind: 'hive-default',
      label: 'Hive default',
      hint: 'Ticket title, sanitized',
      value: opts.hiveDefault
    })
  }

  if (shortName) {
    const seq = formatSequentialPrefix(computeNextSequentialNumber(opts.existingNames ?? []))
    candidates.push({
      kind: 'sequential',
      label: 'Sequential',
      hint: 'Next number + short name',
      value: `${seq}-${shortName}`
    })
    candidates.push({
      kind: 'timestamp',
      label: 'Timestamp',
      hint: 'Date-time + short name',
      value: `${formatTimestampPrefix(opts.now)}-${shortName}`
    })
    candidates.push({
      kind: 'short-name',
      label: 'Short name',
      hint: 'Action-noun only',
      value: shortName
    })
  }

  // De-dupe by value, preserving order (hive default may equal the short name).
  const seen = new Set<string>()
  return candidates.filter((c) => {
    if (!c.value || seen.has(c.value)) return false
    seen.add(c.value)
    return true
  })
}

function normalizePlanTitle(title: string): string {
  const trimmed = title.trim()
  const withoutPrefix = trimmed.replace(/^plan\s*[:\-–—]\s*/i, '').trim()
  return withoutPrefix.length > 0 ? withoutPrefix : trimmed
}

/**
 * Extract a human-readable title from markdown plan content.
 * Looks for the first markdown heading (any level), then falls back to
 * the first non-empty line. Returns null if neither yields text.
 *
 * Used for both deriving a branch name (Supercharge) and deriving a
 * ticket title (Save as Ticket). Lives in shared/ so both main and
 * renderer can import it.
 */
export function extractPlanTitle(content: string): string | null {
  if (!content) return null

  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    const stripped = normalizePlanTitle(headingMatch[1])
    if (stripped.length > 0) return stripped
  }

  const firstLine = content
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()

  if (!firstLine || firstLine.length === 0) return null

  const normalizedFirstLine = normalizePlanTitle(firstLine)
  return normalizedFirstLine.length > 0 ? normalizedFirstLine : null
}
