import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Effect, Either } from 'effect'
import simpleGit from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitLive, resolveGitWorktreesDir } from '../layers'
import { Git } from '../service'

const runGit = <A, E>(program: Effect.Effect<A, E, Git>) =>
  Effect.runPromise(Effect.either(Effect.provide(program, GitLive)))

describe('GitLive', () => {
  let repoPath: string
  let homePath: string
  let worktreesPath: string

  beforeEach(async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'hive-git-effect-'))
    homePath = mkdtempSync(join(tmpdir(), 'hive-home-'))
    worktreesPath = mkdtempSync(join(tmpdir(), 'hive-worktrees-'))
    vi.stubEnv('HOME', homePath)
    // getHiveWorktreesDir() resolves via os.homedir() (which ignores the HOME
    // stub on macOS) or HIVE_WORKTREES_DIR. Pin the latter to a temp dir so each
    // test gets an isolated worktrees root — otherwise worktree-create ops leak
    // into the real ~/.hive-worktrees and the breed/name-collision suffix climbs
    // across runs, making these tests non-deterministic.
    vi.stubEnv('HIVE_WORKTREES_DIR', worktreesPath)
    const git = simpleGit(repoPath)
    await git.init()
    await git.addConfig('user.email', 'test@test.com')
    await git.addConfig('user.name', 'Test')
    writeFileSync(join(repoPath, 'a.txt'), 'original\n')
    await git.add('.')
    await git.commit('init')
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
    rmSync(homePath, { recursive: true, force: true })
    rmSync(worktreesPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('resolves project worktree directories from the Node home directory', () => {
    expect(resolveGitWorktreesDir('project-a', '/tmp/hive-home-test')).toBe(
      join('/tmp/hive-home-test', '.hive-worktrees', 'project-a')
    )
  })

  it('stages and commits through the Git service', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'changed\n')
    const result = await runGit(
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.file.stage(repoPath, 'a.txt')
        return yield* git.commit.commit(repoPath, 'change a')
      })
    )

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.success).toBe(true)
      expect(result.right.commitHash).toMatch(/^[a-f0-9]+$/)
    }
  })

  it('includes committed, modified, and untracked files in the branch diff', async () => {
    const git = simpleGit(repoPath)
    const baseBranch = (await git.branch()).current

    // Diverge on a feature branch: one committed change, one untracked new file.
    await git.checkoutLocalBranch('feature')
    writeFileSync(join(repoPath, 'a.txt'), 'original\nchanged\n')
    await git.add('a.txt')
    await git.commit('modify a')
    writeFileSync(join(repoPath, 'untracked.txt'), 'one\ntwo\nthree\n')

    const result = await runGit(
      Effect.flatMap(Git, (g) => g.diff.branchDiffFiles(repoPath, baseBranch))
    )

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.success).toBe(true)
      const byPath = new Map(result.right.files!.map((f) => [f.relativePath, f]))
      // Committed/tracked change is present (as it always was).
      expect(byPath.has('a.txt')).toBe(true)
      // Untracked file must also appear so this view matches what the PR contains.
      const untracked = byPath.get('untracked.txt')
      expect(untracked).toBeDefined()
      expect(untracked!.status).toBe('A')
      expect(untracked!.additions).toBeGreaterThan(0)
      expect(untracked!.deletions).toBe(0)
    }
  })

  it('classifies operations against a non-git directory as GitNotARepository', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'hive-not-git-'))
    try {
      const result = await runGit(Effect.flatMap(Git, (git) => git.repo.getCurrentBranch(nonRepo)))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe('GitNotARepository')
      }
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  it('classifies invalid patch hunks as GitMergeConflict apply failures', async () => {
    const badHunk = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -99,1 +99,1 @@',
      '-missing',
      '+changed'
    ].join('\n')
    const result = await runGit(Effect.flatMap(Git, (git) => git.file.stageHunk(repoPath, badHunk)))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('GitMergeConflict')
      if (result.left._tag === 'GitMergeConflict') {
        expect(result.left.operation).toBe('apply')
      }
    }
  })

  it('creates a worktree from a branch that is already checked out without timing out', async () => {
    const currentBranch = (await simpleGit(repoPath).branch()).current

    const result = await runGit(
      Effect.gen(function* () {
        const git = yield* Git
        return yield* git.worktree
          .createFromBranch(repoPath, 'project', currentBranch, 'dogs', undefined, {
            autoPull: false,
            nameHint: 'ticket-session'
          })
          .pipe(Effect.timeout('2 seconds'))
      })
    )

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.success).toBe(true)
      expect(result.right.baseBranch).toBe(currentBranch)
      expect(result.right.branchName).toBe('ticket-session')
      expect(result.right.path).toBeDefined()
      expect(existsSync(result.right.path!)).toBe(true)
    }
  })

  it('assigns an existing local branch directly instead of forking a new one', async () => {
    const git = simpleGit(repoPath)
    // The repo's default branch is the diff/PR base; capture it before creating
    // the feature branch (which is NOT checked out, so the repo stays on it).
    const defaultBranch = (await git.branch()).current
    // Create a branch without checking it out in the main repo so it is free to
    // be assigned to a new worktree.
    await git.branch(['feature-assign'])

    const result = await runGit(
      Effect.gen(function* () {
        const g = yield* Git
        return yield* g.worktree
          .createFromExistingBranch(repoPath, 'project', 'feature-assign', { autoPull: false })
          .pipe(Effect.timeout('2 seconds'))
      })
    )

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.success).toBe(true)
      // Checked out as-is — NOT forked into a ticket-named breed branch.
      expect(result.right.branchName).toBe('feature-assign')
      // Base is the repo default (PR target), distinct from the assigned branch —
      // otherwise `git diff <base>...HEAD` would be empty and the PR self-targeted.
      expect(result.right.baseBranch).toBe(defaultBranch)
      expect(result.right.baseBranch).not.toBe('feature-assign')
      expect(result.right.path).toBeDefined()
      expect(existsSync(result.right.path!)).toBe(true)
      // The new worktree's HEAD sits on the assigned branch.
      const wtBranch = (await simpleGit(result.right.path!).branch()).current
      expect(wtBranch).toBe('feature-assign')
    }
  })

  it('refuses to assign a branch already checked out elsewhere', async () => {
    const currentBranch = (await simpleGit(repoPath).branch()).current

    const result = await runGit(
      Effect.flatMap(Git, (g) =>
        g.worktree.createFromExistingBranch(repoPath, 'project', currentBranch, {
          autoPull: false
        })
      )
    )

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.success).toBe(false)
      expect(result.right.error).toMatch(/already checked out/i)
    }
  })
})
