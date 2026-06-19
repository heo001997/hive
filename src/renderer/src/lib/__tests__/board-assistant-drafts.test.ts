import { describe, expect, it } from 'vitest'
import {
  parseBoardAssistantDraftSet,
  extractBoardDraftBlockJson,
  hasBoardDraftBlock,
  removeBoardDraftBlocks
} from '../board-assistant-drafts'

function fence(json: string): string {
  return ['```board-ticket-drafts', json, '```'].join('\n')
}

// A description that itself contains a fenced code block — the case that broke
// the old non-greedy regex extractor.
const CODE_FENCE_DESCRIPTION = ['Use this snippet:', '```ts', 'const x = 1', '```', 'Done.'].join(
  '\n'
)

describe('parseBoardAssistantDraftSet', () => {
  it('parses a basic draft block', () => {
    const payload = {
      drafts: [
        {
          draftKey: 'a',
          title: 'Add login',
          description: 'Add a login form.',
          projectId: 'p1',
          dependsOn: [],
          warnings: []
        }
      ]
    }
    const content = `Here you go:\n${fence(JSON.stringify(payload))}`

    const result = parseBoardAssistantDraftSet(content)
    expect(result).not.toBeNull()
    expect(result?.drafts).toHaveLength(1)
    expect(result?.drafts[0]).toMatchObject({
      draftKey: 'a',
      title: 'Add login',
      description: 'Add a login form.',
      projectId: 'p1'
    })
    expect(result?.drafts[0].validationIssues).toHaveLength(0)
  })

  it('parses a description that contains a code fence (regression)', () => {
    const payload = {
      drafts: [
        {
          draftKey: 'a',
          title: 'Add parser',
          description: CODE_FENCE_DESCRIPTION,
          projectId: 'p1',
          dependsOn: [],
          warnings: []
        }
      ]
    }
    const content = `Sure:\n${fence(JSON.stringify(payload))}\nLet me know.`

    const result = parseBoardAssistantDraftSet(content)
    expect(result).not.toBeNull()
    expect(result?.drafts).toHaveLength(1)
    // Full description preserved, including the inner ``` fences.
    expect(result?.drafts[0].description).toBe(CODE_FENCE_DESCRIPTION)
    expect(result?.drafts[0].description).toContain('```ts')
  })

  it('parses descriptions with quotes and braces', () => {
    const description = 'He said "hi" and used { braces } plus \\backslash.'
    const payload = {
      drafts: [
        {
          draftKey: 'a',
          title: 'Special chars',
          description,
          projectId: 'p1',
          dependsOn: [],
          warnings: []
        }
      ]
    }
    const content = fence(JSON.stringify(payload))

    const result = parseBoardAssistantDraftSet(content)
    expect(result?.drafts[0].description).toBe(description)
  })

  it('returns null when there is no draft block (e.g. a clarifying question)', () => {
    expect(parseBoardAssistantDraftSet('Can you clarify the desired scope?')).toBeNull()
  })

  it('returns null when the block is present but the JSON is malformed', () => {
    const content = fence('{"drafts": [ {this is not valid json ')
    expect(parseBoardAssistantDraftSet(content)).toBeNull()
    // The block is still detectable so the UI can surface a visible error.
    expect(hasBoardDraftBlock(content)).toBe(true)
  })

  it('keeps parse success distinct from validation issues', () => {
    const payload = {
      drafts: [{ draftKey: 'a', title: 'X', description: null, projectId: 'p1', warnings: [] }]
    }
    const content = fence(JSON.stringify(payload))

    const result = parseBoardAssistantDraftSet(content, { strictProjectId: 'p2' })
    // Parsing succeeds even though the draft fails validation.
    expect(result).not.toBeNull()
    expect(result?.drafts[0].validationIssues).toContain('Draft projectId must be p2.')
  })
})

describe('hasBoardDraftBlock', () => {
  it('detects an opening fence even without a closing fence', () => {
    expect(hasBoardDraftBlock('```board-ticket-drafts\n{"drafts":[')).toBe(true)
  })

  it('is false for plain text', () => {
    expect(hasBoardDraftBlock('No drafts here, just chatting.')).toBe(false)
  })
})

describe('extractBoardDraftBlockJson', () => {
  it('returns the balanced JSON object, ignoring fences inside string values', () => {
    const payload = {
      drafts: [
        {
          draftKey: 'a',
          title: 'Add parser',
          description: CODE_FENCE_DESCRIPTION,
          projectId: 'p1',
          dependsOn: [],
          warnings: []
        }
      ]
    }
    const expected = JSON.stringify(payload)
    const content = `prefix\n${fence(expected)}\nsuffix`

    expect(extractBoardDraftBlockJson(content)).toBe(expected)
  })
})

describe('removeBoardDraftBlocks', () => {
  it('strips the whole block, including a code-fence description, leaving surrounding text', () => {
    const payload = {
      drafts: [
        {
          draftKey: 'a',
          title: 'Add parser',
          description: CODE_FENCE_DESCRIPTION,
          projectId: 'p1',
          dependsOn: [],
          warnings: []
        }
      ]
    }
    const content = `Here are the drafts:\n${fence(JSON.stringify(payload))}\nLet me know.`

    const stripped = removeBoardDraftBlocks(content)
    expect(stripped).toContain('Here are the drafts:')
    expect(stripped).toContain('Let me know.')
    expect(stripped).not.toContain('board-ticket-drafts')
    expect(stripped).not.toContain('draftKey')
    // The inner code fence from the description must not leak out either.
    expect(stripped).not.toContain('const x = 1')
  })

  it('returns the original content unchanged when there is no block', () => {
    expect(removeBoardDraftBlocks('plain text')).toBe('plain text')
  })
})
