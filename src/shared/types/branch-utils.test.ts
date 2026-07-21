import { describe, it, expect } from 'vitest'
import {
  deriveBranchShortName,
  computeNextSequentialNumber,
  formatSequentialPrefix,
  formatTimestampPrefix,
  sanitizeCustomBranchName,
  generateBranchNameCandidates
} from './branch-utils'

describe('deriveBranchShortName', () => {
  it('drops stop words and keeps the action-noun core', () => {
    // "add" is a stop word, leaving the three meaningful words.
    expect(deriveBranchShortName('Add user authentication system')).toBe(
      'user-authentication-system'
    )
  })

  it('caps at 3 words unless exactly 4 meaningful words survive', () => {
    // 5 meaningful words → capped to first 3.
    expect(deriveBranchShortName('Refactor payment gateway retry logic handler')).toBe(
      'refactor-payment-gateway'
    )
    // exactly 4 → all 4 kept.
    expect(deriveBranchShortName('Implement OAuth2 integration API')).toBe(
      'implement-oauth2-integration-api'
    )
  })

  it('preserves short acronyms only when uppercase in the source', () => {
    expect(deriveBranchShortName('Fix AI bug')).toBe('fix-ai-bug')
    // lowercase "ai" is a 2-char word with no uppercase form → dropped.
    expect(deriveBranchShortName('fix ai bug')).toBe('fix-bug')
  })

  it('folds in the description when the title is thin', () => {
    // title "Fix" + description → fix/crash/empty/payload are 4 meaningful words → all kept.
    expect(deriveBranchShortName('Fix', 'crash on empty payload')).toBe('fix-crash-empty-payload')
    // A longer description past 4 meaningful words caps back to 3.
    expect(deriveBranchShortName('Fix', 'crash on empty payload during upload')).toBe('fix-crash-empty')
  })

  it('falls back to cleaned tokens when nothing survives', () => {
    expect(deriveBranchShortName('the a an')).toBe('the-a-an')
  })
})

describe('computeNextSequentialNumber', () => {
  it('returns highest NNN- prefix + 1, ignoring timestamp names', () => {
    expect(
      computeNextSequentialNumber([
        '001-foo',
        '003-bar',
        '20260101-120000-baz', // timestamp — excluded
        'main',
        'remotes/origin/002-remote'
      ])
    ).toBe(4)
  })

  it('starts at 1 when there are no sequential names', () => {
    expect(computeNextSequentialNumber(['main', 'feature/x'])).toBe(1)
    expect(computeNextSequentialNumber([])).toBe(1)
  })
})

describe('formatSequentialPrefix / formatTimestampPrefix', () => {
  it('zero-pads the sequential number to 3 digits', () => {
    expect(formatSequentialPrefix(4)).toBe('004')
    expect(formatSequentialPrefix(123)).toBe('123')
  })

  it('formats a timestamp as YYYYMMDD-HHMMSS', () => {
    // Local time; month is 0-indexed (6 = July).
    expect(formatTimestampPrefix(new Date(2026, 6, 21, 14, 30, 22))).toBe('20260721-143022')
  })
})

describe('sanitizeCustomBranchName', () => {
  it('drops slashes/unsafe chars, converts spaces, preserves case', () => {
    expect(sanitizeCustomBranchName('My Cool/Branch!!')).toBe('My-CoolBranch')
  })

  it('trims separators and strips a trailing .lock', () => {
    expect(sanitizeCustomBranchName('  -hotfix-  ')).toBe('hotfix')
    expect(sanitizeCustomBranchName('release.lock')).toBe('release')
  })
})

describe('generateBranchNameCandidates', () => {
  const now = new Date(2026, 6, 21, 14, 30, 22)

  it('offers the Hive default plus speckit sequential/timestamp/short-name', () => {
    const candidates = generateBranchNameCandidates({
      title: 'Add user authentication',
      existingNames: ['002-foo'],
      now,
      hiveDefault: 'add-user-authentication'
    })
    const byKind = Object.fromEntries(candidates.map((c) => [c.kind, c.value]))
    expect(byKind['hive-default']).toBe('add-user-authentication')
    expect(byKind['sequential']).toBe('003-user-authentication')
    expect(byKind['timestamp']).toBe('20260721-143022-user-authentication')
    expect(byKind['short-name']).toBe('user-authentication')
  })

  it('de-duplicates candidates that resolve to the same value', () => {
    // hiveDefault equals the derived short name → only one of them survives.
    const candidates = generateBranchNameCandidates({
      title: 'user auth',
      existingNames: [],
      now,
      hiveDefault: 'user-auth'
    })
    const values = candidates.map((c) => c.value)
    expect(new Set(values).size).toBe(values.length)
    expect(candidates.filter((c) => c.value === 'user-auth')).toHaveLength(1)
  })
})
