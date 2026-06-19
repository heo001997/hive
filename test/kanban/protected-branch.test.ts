import { describe, it, expect } from 'vitest'
import {
  isProtectedBranch,
  parseProtectedBranches
} from '../../src/renderer/src/components/kanban/protectedBranch'

describe('parseProtectedBranches', () => {
  it('splits a comma-separated list, trimming and lowercasing', () => {
    expect(parseProtectedBranches('main,master')).toEqual(['main', 'master'])
    expect(parseProtectedBranches('Main, MASTER , Staging')).toEqual(['main', 'master', 'staging'])
  })

  it('returns an empty array for empty / nullish input', () => {
    expect(parseProtectedBranches('')).toEqual([])
    expect(parseProtectedBranches(null)).toEqual([])
    expect(parseProtectedBranches(undefined)).toEqual([])
  })

  it('drops empty entries from stray commas', () => {
    expect(parseProtectedBranches('main,,  , master')).toEqual(['main', 'master'])
  })
})

describe('isProtectedBranch', () => {
  it('matches branches in the list', () => {
    expect(isProtectedBranch('main', 'main,master')).toBe(true)
    expect(isProtectedBranch('master', 'main,master')).toBe(true)
  })

  it('is trim- and case-insensitive on both sides', () => {
    expect(isProtectedBranch('MAIN', 'main, master')).toBe(true)
    expect(isProtectedBranch('  Staging  ', 'Main, MASTER , Staging')).toBe(true)
  })

  it('returns false for empty / nullish config', () => {
    expect(isProtectedBranch('main', '')).toBe(false)
    expect(isProtectedBranch('main', null)).toBe(false)
    expect(isProtectedBranch('main', undefined)).toBe(false)
  })

  it('returns false for empty / nullish branch', () => {
    expect(isProtectedBranch('', 'main')).toBe(false)
    expect(isProtectedBranch(null, 'main')).toBe(false)
    expect(isProtectedBranch(undefined, 'main')).toBe(false)
  })

  it('matches exactly, not as a substring', () => {
    expect(isProtectedBranch('maintenance', 'main')).toBe(false)
    expect(isProtectedBranch('main', 'maintenance')).toBe(false)
  })
})
