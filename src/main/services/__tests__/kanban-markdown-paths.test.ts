import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureFolder, getDefaultMarkdownConfig } from '../kanban-markdown-paths'
import type { KanbanMarkdownConfig, Project } from '../../db/types'

// TC21 (E2E-deferred): the Human Require column has no dedicated markdown status
// folder in pre-existing configs. `ensureFolder` (and the identical `?? in_progress`
// fallback in kanban-backend's layout migration) must resolve `human_required` to the
// in_progress folder instead of passing `undefined` to resolveProjectPath — which
// would throw `isAbsolute(undefined)` and break the whole single→status migration.

let projectRoot: string

function makeProject(path: string): Project {
  return { id: 'p1', path } as unknown as Project
}

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'hive-md-paths-'))
})
afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('kanban-markdown-paths — Human Require folder', () => {
  it('default status-folders config includes a human-required folder', () => {
    const cfg = getDefaultMarkdownConfig()
    expect(cfg.statusFolders?.human_required).toBe('docs/kanban/human-required')
  })

  it('ensureFolder falls back to the in_progress folder for human_required when unconfigured', async () => {
    // A status-folders config that predates Human Require (no human_required key).
    const legacy: KanbanMarkdownConfig = {
      layout: 'status-folders',
      statusFolders: {
        todo: 'kb/todo',
        in_progress: 'kb/in-progress',
        review: 'kb/review',
        done: 'kb/done'
      }
    }

    // Must NOT throw, and must resolve to the in_progress folder (the fallback).
    const resolved = await ensureFolder(makeProject(projectRoot), legacy, 'human_required')
    expect(resolved).toBe(join(projectRoot, 'kb/in-progress'))
    // ensureFolder creates the directory as a side effect.
    expect((await stat(resolved)).isDirectory()).toBe(true)
  })

  it('ensureFolder uses the configured human_required folder when present', async () => {
    const cfg: KanbanMarkdownConfig = {
      layout: 'status-folders',
      statusFolders: {
        todo: 'k2/todo',
        in_progress: 'k2/in-progress',
        human_required: 'k2/human-required',
        review: 'k2/review',
        done: 'k2/done'
      }
    }
    const resolved = await ensureFolder(makeProject(projectRoot), cfg, 'human_required')
    expect(resolved).toBe(join(projectRoot, 'k2/human-required'))
  })

  it('single-folder layout routes human_required to the shared folder', async () => {
    const cfg: KanbanMarkdownConfig = { layout: 'single-folder', singleFolder: 'kb-single' }
    const resolved = await ensureFolder(makeProject(projectRoot), cfg, 'human_required')
    expect(resolved).toBe(join(projectRoot, 'kb-single'))
  })
})
