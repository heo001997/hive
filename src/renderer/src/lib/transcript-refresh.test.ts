import { describe, expect, it } from 'vitest'

import {
  appendStreamedAssistantFallback,
  type TranscriptMessage,
  type TranscriptStreamingPart
} from './transcript-refresh'

const fixedOptions = {
  createId: () => 'synthetic-1',
  now: () => '2026-01-01T00:00:00.000Z'
}

function assistant(content: string, parts?: TranscriptStreamingPart[]): TranscriptMessage {
  return { id: 'a1', role: 'assistant', content, timestamp: '2025-01-01T00:00:00.000Z', parts }
}

function user(content: string): TranscriptMessage {
  return { id: 'u1', role: 'user', content, timestamp: '2025-01-01T00:00:00.000Z' }
}

describe('appendStreamedAssistantFallback', () => {
  it('appends partial text when reloaded transcript does not cover it (Stop scenario)', () => {
    const refreshed = [user('hi')]
    const result = appendStreamedAssistantFallback(refreshed, {
      streamedContent: 'partial answer that was cut off',
      streamedParts: [{ type: 'text', text: 'partial answer that was cut off' }],
      ...fixedOptions
    })

    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({
      id: 'synthetic-1',
      role: 'assistant',
      content: 'partial answer that was cut off'
    })
  })

  it('does not duplicate when an existing assistant message already covers the stream', () => {
    const refreshed = [user('hi'), assistant('the full final answer text')]
    const result = appendStreamedAssistantFallback(refreshed, {
      streamedContent: 'the full final answer',
      streamedParts: [{ type: 'text', text: 'the full final answer' }],
      ...fixedOptions
    })

    expect(result).toBe(refreshed)
    expect(result).toHaveLength(2)
  })

  it('returns messages unchanged when the partial is empty', () => {
    const refreshed = [user('hi'), assistant('something')]
    const result = appendStreamedAssistantFallback(refreshed, {
      streamedContent: '   ',
      streamedParts: [],
      ...fixedOptions
    })

    expect(result).toBe(refreshed)
  })

  it('appends a tool-only partial when no message carries the streamed tool id', () => {
    const refreshed = [user('hi')]
    const parts: TranscriptStreamingPart[] = [
      {
        type: 'tool_use',
        toolUse: {
          id: 'tool-123',
          name: 'bash',
          input: {},
          status: 'running',
          startTime: 0
        }
      }
    ]
    const result = appendStreamedAssistantFallback(refreshed, {
      streamedContent: '',
      streamedParts: parts,
      ...fixedOptions
    })

    expect(result).toHaveLength(2)
    expect(result[1].parts).toEqual(parts)
  })

  it('does not duplicate a tool-only partial when a message carries the streamed tool id', () => {
    const parts: TranscriptStreamingPart[] = [
      {
        type: 'tool_use',
        toolUse: {
          id: 'tool-123',
          name: 'bash',
          input: {},
          status: 'success',
          startTime: 0
        }
      }
    ]
    const refreshed = [user('hi'), assistant('', parts)]
    const result = appendStreamedAssistantFallback(refreshed, {
      streamedContent: '',
      streamedParts: parts,
      ...fixedOptions
    })

    expect(result).toBe(refreshed)
  })
})
