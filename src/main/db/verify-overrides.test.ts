import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from './database'
import type { VerifyOverrides } from '@shared/types/completion'

// Round-trips the per-ticket `verify_overrides` JSON column (migration v42). DB
// suites SKIP locally when better-sqlite3's native binding isn't loadable in the
// vitest runtime (see [[hive-db-tests-skip-locally]]); they run in CI.
const tempDirs: string[] = []
let databaseLoadError: Error | null = null

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch (error) {
    databaseLoadError = error as Error
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describeIf('kanban ticket verify_overrides', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  function freshDb(): { db: DatabaseService; projectId: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hive-verify-overrides-db-'))
    tempDirs.push(dir)
    const db = new DatabaseService(join(dir, 'state.sqlite'))
    db.init()
    const project = db.createProject({ name: 'repo', path: join(dir, 'repo') })
    return { db, projectId: project.id }
  }

  it('defaults to null and round-trips a partial override object', () => {
    const { db, projectId } = freshDb()
    const ticket = db.createKanbanTicket({ project_id: projectId, title: 'gate ticket' })
    expect(ticket.verify_overrides).toBeNull()

    const overrides: VerifyOverrides = { llmReviewer: true, frozenIdleSeconds: 12 }
    const updated = db.updateKanbanTicket(ticket.id, { verify_overrides: overrides })
    expect(updated?.verify_overrides).toEqual(overrides)
    // Survives a fresh read (JSON hydrate path), not just the in-memory update return.
    expect(db.getKanbanTicket(ticket.id)?.verify_overrides).toEqual(overrides)
    db.close()
  })

  it('clears back to null when the override is set to null', () => {
    const { db, projectId } = freshDb()
    const ticket = db.createKanbanTicket({ project_id: projectId, title: 'gate ticket' })
    db.updateKanbanTicket(ticket.id, { verify_overrides: { gateLoop: false } })
    expect(db.getKanbanTicket(ticket.id)?.verify_overrides).toEqual({ gateLoop: false })

    db.updateKanbanTicket(ticket.id, { verify_overrides: null })
    expect(db.getKanbanTicket(ticket.id)?.verify_overrides).toBeNull()
    db.close()
  })
})
