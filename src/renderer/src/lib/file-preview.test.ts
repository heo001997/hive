import { describe, expect, it } from 'vitest'
import { classifyPreview, extensionOf, mimeForPath } from './file-preview'

describe('extensionOf', () => {
  it('returns the lower-cased extension without the dot', () => {
    expect(extensionOf('/tmp/Report.PDF')).toBe('pdf')
    expect(extensionOf('C:\\docs\\Photo.JPEG')).toBe('jpeg')
  })

  it('returns empty string when there is no extension', () => {
    expect(extensionOf('/tmp/README')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })
})

describe('classifyPreview', () => {
  it('detects images', () => {
    expect(classifyPreview('a.png')).toBe('image')
    expect(classifyPreview('a.svg')).toBe('image')
  })
  it('detects pdf', () => {
    expect(classifyPreview('/x/spec.pdf')).toBe('pdf')
  })
  it('detects text and code', () => {
    expect(classifyPreview('notes.md')).toBe('text')
    expect(classifyPreview('main.ts')).toBe('text')
    expect(classifyPreview('data.json')).toBe('text')
  })
  it('detects audio and video', () => {
    expect(classifyPreview('song.mp3')).toBe('audio')
    expect(classifyPreview('clip.mp4')).toBe('video')
  })
  it('falls back to other for unknown/binary types', () => {
    expect(classifyPreview('archive.zip')).toBe('other')
    expect(classifyPreview('doc.docx')).toBe('other')
    expect(classifyPreview('noext')).toBe('other')
  })
})

describe('mimeForPath', () => {
  it('maps known types', () => {
    expect(mimeForPath('a.png')).toBe('image/png')
    expect(mimeForPath('a.pdf')).toBe('application/pdf')
    expect(mimeForPath('a.mp4')).toBe('video/mp4')
    expect(mimeForPath('a.mp3')).toBe('audio/mpeg')
  })
  it('falls back to octet-stream', () => {
    expect(mimeForPath('a.zip')).toBe('application/octet-stream')
  })
})
