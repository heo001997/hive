// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import {
  createInteractiveReplyRouter,
  type InteractiveReplyRouterDependencies
} from '../interactive-reply-router'

class FakeSettingsDb {
  settings = new Map<string, string>()

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value)
  }
}

const makeRouter = (overrides: Partial<InteractiveReplyRouterDependencies> = {}) => {
  const db = new FakeSettingsDb()
  const openCodeService = {
    questionReply: vi.fn(async () => undefined),
    questionReject: vi.fn(async () => undefined),
    permissionReply: vi.fn(async () => undefined)
  }
  const router = createInteractiveReplyRouter({
    db: db as never,
    openCodeService: openCodeService as never,
    ...overrides
  })
  return { router, db, openCodeService }
}

describe('interactive reply router', () => {
  it('falls back to OpenCode when no SDK implementer has the question pending (CLI questions stay in the terminal)', async () => {
    const { router, openCodeService } = makeRouter()

    await router.replyQuestion({
      requestId: 'req-1',
      answers: [['A']],
      worktreePath: '/repo/worktree'
    })

    expect(openCodeService.questionReply).toHaveBeenCalledWith('req-1', [['A']], '/repo/worktree')
  })

  it('routes SDK questions to Claude first, then Codex by pending request id', async () => {
    const claude = {
      hasPendingQuestion: vi.fn(() => false),
      questionReply: vi.fn(async () => undefined)
    }
    const codex = {
      hasPendingQuestion: vi.fn(() => true),
      questionReply: vi.fn(async () => undefined)
    }
    const sdkManager = {
      getImplementer: vi.fn((sdk: string) => (sdk === 'claude-code' ? claude : codex))
    }
    const { router, openCodeService } = makeRouter({ sdkManager: sdkManager as never })

    await router.replyQuestion({ requestId: 'req-2', answers: [['id', 'answer']] })

    expect(codex.questionReply).toHaveBeenCalledWith('req-2', [['id', 'answer']], undefined)
    expect(openCodeService.questionReply).not.toHaveBeenCalled()
  })

  it('rejects questions through the SDK (Claude then Codex), then OpenCode cascade', async () => {
    const claude = {
      hasPendingQuestion: vi.fn(() => false),
      questionReject: vi.fn(async () => undefined)
    }
    const codex = {
      hasPendingQuestion: vi.fn(() => true),
      questionReject: vi.fn(async () => undefined)
    }
    const sdkManager = {
      getImplementer: vi.fn((sdk: string) => (sdk === 'claude-code' ? claude : codex))
    }
    const { router, openCodeService } = makeRouter({ sdkManager: sdkManager as never })

    await router.rejectQuestion({ requestId: 'req-3', worktreePath: '/repo/worktree' })

    expect(codex.questionReject).toHaveBeenCalledWith('req-3', '/repo/worktree')
    expect(openCodeService.questionReject).not.toHaveBeenCalled()
  })

  it('persists Allow always sub-patterns before replying to an OpenCode permission', async () => {
    const { router, db, openCodeService } = makeRouter()
    db.setSetting(
      APP_SETTINGS_DB_KEY,
      JSON.stringify({ commandFilter: { allowlist: ['bash: npm test'] } })
    )

    await router.replyPermission({
      requestId: 'perm-1',
      decision: 'always',
      worktreePath: '/repo/worktree',
      permissionRequest: {
        id: 'perm-1',
        sessionID: 'hive-1',
        permission: 'bash',
        patterns: ['git status && npm test'],
        metadata: {},
        always: []
      }
    })

    expect(openCodeService.permissionReply).toHaveBeenCalledWith(
      'perm-1',
      'always',
      '/repo/worktree'
    )
    expect(JSON.parse(db.getSetting(APP_SETTINGS_DB_KEY) ?? '{}').commandFilter.allowlist).toEqual([
      'bash: npm test',
      'bash: git status'
    ])
  })

  it('routes command Allow as remember allow with all pattern suggestions', async () => {
    const claude = {
      handleApprovalReply: vi.fn()
    }
    const sdkManager = {
      getImplementer: vi.fn(() => claude)
    }
    const { router } = makeRouter({ sdkManager: sdkManager as never })

    await router.replyCommandApproval({
      requestId: 'cmd-1',
      approved: true,
      patternSuggestions: ['bash: git status', 'bash: npm test']
    })

    expect(claude.handleApprovalReply).toHaveBeenCalledWith(
      'cmd-1',
      true,
      'allow',
      undefined,
      ['bash: git status', 'bash: npm test']
    )
  })

  it('routes plan rejection to the Claude SDK pending plan', async () => {
    const claude = {
      hasPendingPlan: vi.fn(() => true),
      hasPendingPlanForSession: vi.fn(() => false),
      planApprove: vi.fn(async () => undefined),
      planReject: vi.fn(async () => undefined)
    }
    const sdkManager = { getImplementer: vi.fn(() => claude) }
    const { router } = makeRouter({ sdkManager: sdkManager as never })

    await router.replyPlan({
      requestId: 'plan-1',
      sessionId: 'hive-1',
      approve: false,
      feedback: 'Need a smaller plan'
    })

    expect(claude.planReject).toHaveBeenCalledWith('', 'hive-1', 'Need a smaller plan', 'plan-1')
  })

  it('throws when no SDK implementer has the plan pending (CLI plans stay in the terminal)', async () => {
    const { router } = makeRouter()

    await expect(
      router.replyPlan({ requestId: 'plan-x', sessionId: 'hive-1', approve: true })
    ).rejects.toThrow('Plan is no longer pending')
  })
})
