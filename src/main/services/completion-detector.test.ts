import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the text-generation router so no real provider is invoked.
const generateText = vi.fn()
vi.mock('./text-generation-router', () => ({
  generateText: (...args: unknown[]) => generateText(...args)
}))

import {
  buildTranscriptTail,
  detectTicketCompletion,
  DEFAULT_TAIL_CHARS
} from './completion-detector'
import { DEFAULT_STRICT_VERIFY_PROMPT } from '@shared/types/completion'

afterEach(() => {
  generateText.mockReset()
})

describe('buildTranscriptTail', () => {
  it('joins messages oldest→newest as [role] content', () => {
    const out = buildTranscriptTail([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'done' }
    ])
    expect(out).toBe('[user] do the thing\n\n[assistant] done')
  })

  it('drops messages whose content is empty/whitespace', () => {
    const out = buildTranscriptTail([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'kept' }
    ])
    expect(out).toBe('[assistant] kept')
  })

  it('keeps only the last `maxChars` and prefixes a truncation marker', () => {
    const long = 'x'.repeat(5000)
    const out = buildTranscriptTail([{ role: 'assistant', content: long }], 100)
    expect(out.startsWith('… (earlier transcript truncated)')).toBe(true)
    // marker + last 100 chars of the joined string
    expect(out.endsWith('x'.repeat(100))).toBe(true)
  })

  it('does not truncate when the joined transcript fits the cap', () => {
    const out = buildTranscriptTail([{ role: 'assistant', content: 'short' }], 1000)
    expect(out).toBe('[assistant] short')
    expect(out).not.toContain('truncated')
  })

  it('defaults to DEFAULT_TAIL_CHARS when no cap is given', () => {
    const long = 'y'.repeat(DEFAULT_TAIL_CHARS + 2000)
    const out = buildTranscriptTail([{ role: 'assistant', content: long }])
    // marker + cap chars; never larger than marker + DEFAULT_TAIL_CHARS
    expect(out.length).toBeLessThanOrEqual('… (earlier transcript truncated)\n\n'.length + DEFAULT_TAIL_CHARS)
    expect(out).toContain('truncated')
  })
})

describe('detectTicketCompletion', () => {
  const base = {
    ticketTitle: 'Add logout button',
    ticketDescription: 'Wire a logout action in the header',
    provider: 'claude-code' as const
  }

  it('short-circuits on an empty transcript without calling the provider', async () => {
    const verdict = await detectTicketCompletion({ ...base, transcriptTail: '   ' })
    expect(verdict).toEqual({
      complete: false,
      needsInput: false,
      confidence: 0,
      reason: 'No session transcript available to review.'
    })
    expect(generateText).not.toHaveBeenCalled()
  })

  it('parses a raw JSON verdict and forwards provider/cwd/schema', async () => {
    generateText.mockResolvedValue('{"complete":true,"needsInput":false,"confidence":0.9,"reason":"All tests pass"}')
    const verdict = await detectTicketCompletion({
      ...base,
      transcriptTail: '[assistant] finished and ran tests',
      cwd: '/repo'
    })
    expect(verdict).toEqual({
      complete: true,
      needsInput: false,
      confidence: 0.9,
      reason: 'All tests pass'
    })

    const [, , provider, opts] = generateText.mock.calls[0]
    expect(provider).toBe('claude-code')
    expect(opts.cwd).toBe('/repo')
    expect(typeof opts.outputSchema).toBe('string')
  })

  it('reads needsInput=true when the agent is asking the user', async () => {
    generateText.mockResolvedValue(
      '{"complete":false,"needsInput":true,"confidence":0.8,"reason":"Which auth flow?"}'
    )
    const verdict = await detectTicketCompletion({ ...base, transcriptTail: 'x' })
    expect(verdict.needsInput).toBe(true)
    expect(verdict.complete).toBe(false)
    expect(verdict.reason).toBe('Which auth flow?')
  })

  it('defaults needsInput to false when the field is absent', async () => {
    generateText.mockResolvedValue('{"complete":false,"confidence":0.4,"reason":"TODOs remain"}')
    const verdict = await detectTicketCompletion({ ...base, transcriptTail: 'x' })
    expect(verdict.needsInput).toBe(false)
  })

  it('forwards modelOverride to the provider', async () => {
    generateText.mockResolvedValue('{"complete":true,"needsInput":false,"confidence":1,"reason":"ok"}')
    await detectTicketCompletion({ ...base, transcriptTail: 'x', modelOverride: 'gpt-5-mini' })
    const [, , , opts] = generateText.mock.calls[0]
    expect(opts.modelOverride).toBe('gpt-5-mini')
  })

  it('omits modelOverride when not provided', async () => {
    generateText.mockResolvedValue('{"complete":true,"needsInput":false,"confidence":1,"reason":"ok"}')
    await detectTicketCompletion({ ...base, transcriptTail: 'x' })
    const [, , , opts] = generateText.mock.calls[0]
    expect(opts.modelOverride).toBeUndefined()
  })

  it('uses the built-in system prompt when no override is given', async () => {
    generateText.mockResolvedValue('{"complete":true,"needsInput":false,"confidence":1,"reason":"ok"}')
    await detectTicketCompletion({ ...base, transcriptTail: 'x' })
    const [, systemPrompt] = generateText.mock.calls[0]
    expect(systemPrompt).toBe(DEFAULT_STRICT_VERIFY_PROMPT)
  })

  it('forwards systemPromptOverride as the system prompt', async () => {
    generateText.mockResolvedValue('{"complete":true,"needsInput":false,"confidence":1,"reason":"ok"}')
    const custom = 'You are a strict reviewer. Reply with JSON {complete, needsInput, confidence, reason}.'
    await detectTicketCompletion({ ...base, transcriptTail: 'x', systemPromptOverride: custom })
    const [, systemPrompt] = generateText.mock.calls[0]
    expect(systemPrompt).toBe(custom)
  })

  it('falls back to the built-in prompt when the override is blank/whitespace', async () => {
    generateText.mockResolvedValue('{"complete":true,"needsInput":false,"confidence":1,"reason":"ok"}')
    await detectTicketCompletion({ ...base, transcriptTail: 'x', systemPromptOverride: '   ' })
    const [, systemPrompt] = generateText.mock.calls[0]
    expect(systemPrompt).toBe(DEFAULT_STRICT_VERIFY_PROMPT)
  })

  it('extracts JSON wrapped in a markdown code fence', async () => {
    generateText.mockResolvedValue('```json\n{"complete":false,"confidence":0.4,"reason":"TODOs remain"}\n```')
    const verdict = await detectTicketCompletion({ ...base, transcriptTail: 'x' })
    expect(verdict.complete).toBe(false)
    expect(verdict.reason).toBe('TODOs remain')
  })

  it('clamps confidence into [0,1]', async () => {
    generateText.mockResolvedValue('{"complete":true,"confidence":5,"reason":"r"}')
    expect((await detectTicketCompletion({ ...base, transcriptTail: 'x' })).confidence).toBe(1)

    generateText.mockResolvedValue('{"complete":false,"confidence":-3,"reason":"r"}')
    expect((await detectTicketCompletion({ ...base, transcriptTail: 'x' })).confidence).toBe(0)
  })

  it('throws when the response is unparseable', async () => {
    generateText.mockResolvedValue('not json at all')
    await expect(detectTicketCompletion({ ...base, transcriptTail: 'x' })).rejects.toThrow()
  })

  it('throws when the verdict is missing the boolean "complete" field', async () => {
    generateText.mockResolvedValue('{"confidence":0.5,"reason":"r"}')
    await expect(detectTicketCompletion({ ...base, transcriptTail: 'x' })).rejects.toThrow(/complete/)
  })

  it('throws when the provider returns an empty response', async () => {
    generateText.mockResolvedValue('')
    await expect(detectTicketCompletion({ ...base, transcriptTail: 'x' })).rejects.toThrow()
  })
})
