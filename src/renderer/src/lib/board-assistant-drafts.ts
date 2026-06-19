import type { BoardAssistantDraft } from '../../../main/db/types'

// Matches only the opening fence + label (plus optional trailing horizontal
// whitespace and one newline). The JSON body and closing fence are located
// separately by brace-matching so descriptions containing their own ``` code
// fences do not truncate the block.
const BOARD_DRAFT_BLOCK_OPEN_SOURCE = '```[ \\t]*board-ticket-drafts[ \\t]*\\r?\\n?'
export const BOARD_DRAFT_BLOCK_OPEN_RE = new RegExp(BOARD_DRAFT_BLOCK_OPEN_SOURCE, 'i')

interface BoardDraftBlock {
  /** Index of the opening fence. */
  start: number
  /** Index just past the closing fence (or end of content if none found). */
  end: number
  /** The balanced JSON object string, or null if no valid object was found. */
  json: string | null
}

/**
 * Scans `content` for a balanced JSON object starting at the first `{` on or
 * after `fromIndex`, tracking string literals/escapes so that braces and
 * backtick fences inside string values are ignored.
 */
function matchJsonObject(content: string, fromIndex: number): { json: string; end: number } | null {
  const braceStart = content.indexOf('{', fromIndex)
  if (braceStart === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = braceStart; i < content.length; i += 1) {
    const char = content[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return { json: content.slice(braceStart, i + 1), end: i + 1 }
      }
    }
  }

  return null
}

/** Locates every board-ticket-drafts block in `content`, in order. */
function findBoardDraftBlocks(content: string): BoardDraftBlock[] {
  const blocks: BoardDraftBlock[] = []
  const openRe = new RegExp(BOARD_DRAFT_BLOCK_OPEN_SOURCE, 'gi')

  let openMatch: RegExpExecArray | null
  while ((openMatch = openRe.exec(content)) !== null) {
    const start = openMatch.index
    const afterLabel = openMatch.index + openMatch[0].length
    const matched = matchJsonObject(content, afterLabel)

    if (matched) {
      // Closing fence is the first ``` after the JSON body; if the model
      // omitted it, consume to the end of the content.
      const closingFence = content.indexOf('```', matched.end)
      const end = closingFence === -1 ? content.length : closingFence + 3
      blocks.push({ start, end, json: matched.json })
      openRe.lastIndex = end
    } else {
      // Malformed block (no balanced JSON object). Best-effort: strip through
      // the last fence so a broken JSON blob is not leaked into the chat.
      const lastFence = content.lastIndexOf('```')
      const end = lastFence > afterLabel ? lastFence + 3 : content.length
      blocks.push({ start, end, json: null })
      openRe.lastIndex = end
    }
  }

  return blocks
}

/** True when `content` contains a board-ticket-drafts fenced block. */
export function hasBoardDraftBlock(content: string): boolean {
  return BOARD_DRAFT_BLOCK_OPEN_RE.test(content)
}

/** Returns the JSON body of the first valid board-ticket-drafts block, if any. */
export function extractBoardDraftBlockJson(content: string): string | null {
  for (const block of findBoardDraftBlocks(content)) {
    if (block.json !== null) return block.json
  }
  return null
}

/** Removes every board-ticket-drafts block from `content`. */
export function removeBoardDraftBlocks(content: string): string {
  const blocks = findBoardDraftBlocks(content)
  if (blocks.length === 0) return content

  let result = ''
  let cursor = 0
  for (const block of blocks) {
    result += content.slice(cursor, block.start)
    cursor = block.end
  }
  result += content.slice(cursor)
  return result
}

export interface ParsedBoardAssistantDraft extends BoardAssistantDraft {
  validationIssues: string[]
}

export interface ParsedBoardAssistantDraftSet {
  drafts: ParsedBoardAssistantDraft[]
  dependencyCount: number
  hasValidationErrors: boolean
  usesDependencySchema: boolean
}

interface ParseBoardAssistantDraftSetOptions {
  fallbackProjectId?: string | null
  strictProjectId?: string | null
  requireExplicitDraftKeys?: boolean
}

function makeFallbackDraftKey(index: number): string {
  return `draft-${index + 1}`
}

export function parseBoardAssistantDraftSet(
  content: string,
  options: ParseBoardAssistantDraftSetOptions = {}
): ParsedBoardAssistantDraftSet | null {
  const json = extractBoardDraftBlockJson(content)
  if (json === null) return null

  try {
    const parsed = JSON.parse(json) as { drafts?: unknown[] }
    if (!Array.isArray(parsed.drafts)) return null

    const drafts = parsed.drafts
      .map((draft, index): ParsedBoardAssistantDraft | null => {
        if (!draft || typeof draft !== 'object') return null

        const record = draft as Record<string, unknown>
        const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
        const rawDraftKey = typeof record.draftKey === 'string' ? record.draftKey.trim() : ''
        const projectId =
          typeof record.projectId === 'string' && record.projectId.trim()
            ? record.projectId.trim()
            : options.fallbackProjectId?.trim() ?? ''
        const dependsOn = Array.isArray(record.dependsOn)
          ? Array.from(
              new Set(
                record.dependsOn
                  .filter((dependency): dependency is string => typeof dependency === 'string')
                  .map((dependency) => dependency.trim())
                  .filter(Boolean)
              )
            )
          : []
        const warnings = Array.isArray(record.warnings)
          ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
          : []
        const validationIssues: string[] = []

        if (!rawTitle) {
          validationIssues.push('Draft is missing a title.')
        }
        if (!projectId) {
          validationIssues.push('Draft is missing a projectId.')
        }
        if (options.strictProjectId && projectId && projectId !== options.strictProjectId) {
          validationIssues.push(`Draft projectId must be ${options.strictProjectId}.`)
        }
        if (options.requireExplicitDraftKeys && !rawDraftKey) {
          validationIssues.push('Draft is missing a draftKey.')
        }

        const draftKey = rawDraftKey || makeFallbackDraftKey(index)

        return {
          draftKey,
          title: rawTitle || `Untitled draft ${index + 1}`,
          description:
            typeof record.description === 'string' && record.description.trim()
              ? record.description.trim()
              : null,
          projectId,
          dependsOn,
          warnings,
          validationIssues
        }
      })
      .filter((draft): draft is ParsedBoardAssistantDraft => draft !== null)

    const draftKeyCounts = new Map<string, number>()
    for (const draft of drafts) {
      draftKeyCounts.set(draft.draftKey, (draftKeyCounts.get(draft.draftKey) ?? 0) + 1)
    }

    const draftMap = new Map(drafts.map((draft) => [draft.draftKey, draft]))
    for (const draft of drafts) {
      if ((draftKeyCounts.get(draft.draftKey) ?? 0) > 1) {
        draft.validationIssues.push(`Duplicate draftKey "${draft.draftKey}".`)
      }

      for (const dependency of draft.dependsOn) {
        if (dependency === draft.draftKey) {
          draft.validationIssues.push('Draft cannot depend on itself.')
          continue
        }
        if (!draftMap.has(dependency)) {
          draft.validationIssues.push(`Depends on unknown draftKey "${dependency}".`)
        }
      }
    }

    const visitState = new Map<string, 'visiting' | 'done'>()
    const cycleKeys = new Set<string>()
    const visit = (draftKey: string, trail: string[]): void => {
      const state = visitState.get(draftKey)
      if (state === 'visiting') {
        const cycleStart = trail.indexOf(draftKey)
        const cycleTrail = cycleStart >= 0 ? trail.slice(cycleStart) : [draftKey]
        for (const key of cycleTrail) {
          cycleKeys.add(key)
        }
        return
      }
      if (state === 'done') return

      visitState.set(draftKey, 'visiting')
      const draft = draftMap.get(draftKey)
      if (draft) {
        for (const dependency of draft.dependsOn) {
          if (!draftMap.has(dependency)) continue
          visit(dependency, [...trail, draftKey])
        }
      }
      visitState.set(draftKey, 'done')
    }

    for (const draft of drafts) {
      visit(draft.draftKey, [])
    }

    for (const cycleKey of cycleKeys) {
      draftMap.get(cycleKey)?.validationIssues.push('Draft is part of a dependency cycle.')
    }

    return {
      drafts,
      dependencyCount: drafts.reduce((count, draft) => count + draft.dependsOn.length, 0),
      hasValidationErrors: drafts.some((draft) => draft.validationIssues.length > 0),
      usesDependencySchema: drafts.some((draft) => draft.dependsOn.length > 0 || !draft.draftKey.startsWith('draft-'))
    }
  } catch {
    return null
  }
}
