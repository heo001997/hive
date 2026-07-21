// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const backendManagerMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: backendManagerMocks.publishDesktopBackendEvent
}))

import {
  buildClaudeCliHookSettings,
  clearClaudeCliStatus,
  closeClaudeHookServer,
  getClaudeHookServer,
  mapHookEventToStatus,
  publishClaudeCliStatus,
  resolveClaudeCliStatus,
  type ParsedClaudeHook
} from '../claude-hook-server'

async function postHook(
  port: number,
  sessionId: string,
  path: 'session' | 'start' | 'stop' | 'subagent' | 'tool' | 'permission' | 'compact' | 'event',
  body: Record<string, unknown> | string
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/hook/${sessionId}/${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'content-type': 'application/json'
    }
  })

  return { status: response.status, text: await response.text() }
}

async function getHook(
  port: number,
  sessionId: string,
  path: 'session' | 'start' | 'stop' | 'tool' | 'permission'
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/hook/${sessionId}/${path}`)

  return { status: response.status, text: await response.text() }
}

afterEach(async () => {
  await closeClaudeHookServer()
  vi.clearAllMocks()
  backendManagerMocks.publishDesktopBackendEvent.mockReset()
})

describe('mapHookEventToStatus', () => {
  it.each<[string, ParsedClaudeHook, string | null]>([
    ['SessionStart maps to completed', { hook_event_name: 'SessionStart' }, 'completed'],
    ['SessionEnd maps to completed', { hook_event_name: 'SessionEnd' }, 'completed'],
    [
      'UserPromptSubmit in plan mode maps to planning',
      { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan' },
      'planning'
    ],
    [
      'UserPromptSubmit in default mode maps to working',
      { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' },
      'working'
    ],
    ['Stop maps to completed', { hook_event_name: 'Stop' }, 'completed'],
    [
      'PreToolUse ExitPlanMode maps to plan_ready',
      { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' },
      'plan_ready'
    ],
    [
      'PreToolUse AskUserQuestion is ignored (renders in the native terminal)',
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' },
      null
    ],
    [
      'PostToolUse ExitPlanMode maps to working',
      { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode' },
      'working'
    ],
    [
      'PostToolUse other tool maps to working',
      { hook_event_name: 'PostToolUse', tool_name: 'Read' },
      'working'
    ],
    [
      'PostToolUseFailure ExitPlanMode maps to planning',
      { hook_event_name: 'PostToolUseFailure', tool_name: 'ExitPlanMode' },
      'planning'
    ],
    ['PostToolUseFailure maps to working', { hook_event_name: 'PostToolUseFailure' }, 'working'],
    [
      'PermissionRequest maps to permission',
      { hook_event_name: 'PermissionRequest' },
      'permission'
    ],
    [
      'PermissionRequest for ExitPlanMode maps to plan_ready',
      { hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode' },
      'plan_ready'
    ],
    [
      'PermissionRequest for AskUserQuestion maps to permission',
      { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' },
      'permission'
    ],
    ['PostToolBatch maps to working', { hook_event_name: 'PostToolBatch' }, 'working'],
    ['PermissionDenied maps to working', { hook_event_name: 'PermissionDenied' }, 'working'],
    ['Elicitation maps to permission', { hook_event_name: 'Elicitation' }, 'permission'],
    ['ElicitationResult maps to working', { hook_event_name: 'ElicitationResult' }, 'working'],
    ['PreCompact maps to working', { hook_event_name: 'PreCompact' }, 'working'],
    ['PostCompact maps to working', { hook_event_name: 'PostCompact' }, 'working'],
    ['Notification is notify-only (ignored)', { hook_event_name: 'Notification' }, null],
    ['MessageDisplay is ignored', { hook_event_name: 'MessageDisplay' }, null],
    ['TaskCreated is ignored', { hook_event_name: 'TaskCreated' }, null],
    ['WorktreeCreate is ignored', { hook_event_name: 'WorktreeCreate' }, null],
    // Stop-family + sub-agent lifecycle are resolved statefully (see
    // resolveClaudeCliStatus); the PURE mapper leaves them null.
    ['StopFailure is null in the pure mapper', { hook_event_name: 'StopFailure' }, null],
    ['SubagentStart is null in the pure mapper', { hook_event_name: 'SubagentStart' }, null],
    ['SubagentStop is null in the pure mapper', { hook_event_name: 'SubagentStop' }, null],
    ['unknown events are ignored', { hook_event_name: 'BogusEvent' }, null],
    [
      'unmatched PreToolUse events are ignored',
      { hook_event_name: 'PreToolUse', tool_name: 'Read' },
      null
    ]
  ])('%s', (_name, hook, expected) => {
    expect(mapHookEventToStatus(hook)).toBe(expected)
  })
})

describe('resolveClaudeCliStatus (sub-agent aware)', () => {
  const S = 'hive-session-subagent'
  // Stateful (per-session sub-agent depth) — reset the module maps between tests.
  afterEach(() => clearClaudeCliStatus(S))

  it('defers a Stop fired while a sub-agent is running (stays working)', () => {
    // Turn begins, spawns a sub-agent, then the main turn ends while it runs.
    expect(
      resolveClaudeCliStatus(S, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' })
    ).toBe('working')
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStart' })).toBe('working')
    // The Stop must NOT report completed — the main agent is waiting on the sub-agent.
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Stop' })).toBe('working')
    // Only when the sub-agent finishes does the whole process become completed.
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStop' })).toBe('completed')
  })

  it('reports completed for a Stop with no sub-agent in flight (no regression)', () => {
    expect(
      resolveClaudeCliStatus(S, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' })
    ).toBe('working')
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Stop' })).toBe('completed')
  })

  it('StopFailure behaves like Stop: completes when idle, defers under a sub-agent', () => {
    // No sub-agent in flight → an API-error turn end still completes (surfaces
    // for a human instead of stranding the ticket In Progress).
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'StopFailure' })).toBe('completed')
    // Under a running sub-agent → deferred until it stops.
    resolveClaudeCliStatus(S, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' })
    resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStart' })
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'StopFailure' })).toBe('working')
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStop' })).toBe('completed')
  })

  it('keeps working through a synchronous sub-agent, completes on the later main Stop', () => {
    resolveClaudeCliStatus(S, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' })
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStart' })).toBe('working')
    // Sub-agent finishes BEFORE the main turn ends — not completed yet.
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStop' })).toBe('working')
    expect(
      resolveClaudeCliStatus(S, { hook_event_name: 'PostToolUse', tool_name: 'Task' })
    ).toBe('working')
    // Main agent then genuinely finishes.
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Stop' })).toBe('completed')
  })

  it('balances nested/parallel sub-agents before completing', () => {
    resolveClaudeCliStatus(S, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' })
    resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStart' }) // depth 1
    resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStart' }) // depth 2
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Stop' })).toBe('working') // deferred
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStop' })).toBe('working') // depth 1
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStop' })).toBe('completed') // depth 0
  })

  it('a fresh UserPromptSubmit clears stale sub-agent bookkeeping', () => {
    resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStart' }) // depth 1, no SubagentStop ever arrives
    // New turn resets the counter; its own Stop must complete normally.
    expect(
      resolveClaudeCliStatus(S, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' })
    ).toBe('working')
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Stop' })).toBe('completed')
  })

  it('never underflows: a bare SubagentStop stays working', () => {
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'SubagentStop' })).toBe('working')
    // And a following Stop with no in-flight sub-agent still completes.
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Stop' })).toBe('completed')
  })

  it('PreToolUse{Task} is liveness-only and does not defer a later Stop', () => {
    resolveClaudeCliStatus(S, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' })
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'PreToolUse', tool_name: 'Task' })).toBe(
      'working'
    )
    // No SubagentStart fired → depth is 0 → the Stop completes normally.
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Stop' })).toBe('completed')
  })

  it('non-Task PreToolUse and other events still defer to the pure mapper', () => {
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'PreToolUse', tool_name: 'Read' })).toBe(
      null
    )
    expect(
      resolveClaudeCliStatus(S, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' })
    ).toBe('plan_ready')
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'PostToolUse', tool_name: 'Read' })).toBe(
      'working'
    )
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'PreCompact' })).toBe('working')
    expect(resolveClaudeCliStatus(S, { hook_event_name: 'Elicitation' })).toBe('permission')
  })
})

describe('buildClaudeCliHookSettings', () => {
  type HookEntry = { matcher?: string; hooks: { type: string; url: string }[] }
  type HookSettings = { hooks: Record<string, HookEntry[]> }

  // Every documented Claude Code hook event (all 30).
  const EXPECTED_EVENTS = [
    'SessionStart',
    'SessionEnd',
    'Setup',
    'UserPromptSubmit',
    'UserPromptExpansion',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PostToolBatch',
    'PermissionDenied',
    'PermissionRequest',
    'Elicitation',
    'ElicitationResult',
    'PreCompact',
    'PostCompact',
    'Notification',
    'MessageDisplay',
    'TaskCreated',
    'TaskCompleted',
    'TeammateIdle',
    'InstructionsLoaded',
    'ConfigChange',
    'CwdChanged',
    'FileChanged',
    'WorktreeCreate',
    'WorktreeRemove'
  ]

  it('registers every documented hook event (all 30, including MessageDisplay)', () => {
    const settings = JSON.parse(buildClaudeCliHookSettings(34819, 'hive-session-1')) as HookSettings
    expect(Object.keys(settings.hooks).sort()).toEqual([...EXPECTED_EVENTS].sort())
    expect(settings.hooks).toHaveProperty('MessageDisplay')
  })

  it('points every hook at a session-scoped localhost URL', () => {
    const settings = JSON.parse(buildClaudeCliHookSettings(34819, 'hive-session-1')) as HookSettings
    const urls = Object.values(settings.hooks)
      .flat()
      .flatMap((entry) => entry.hooks)
      .map((h) => h.url)
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:34819\/hook\/hive-session-1\/[a-z]+$/)
    }
  })

  it('scopes PreToolUse to ExitPlanMode + Task, wildcards the tool/permission hooks, and buckets by path', () => {
    const settings = JSON.parse(buildClaudeCliHookSettings(34819, 'hive-session-1')) as HookSettings

    expect(settings.hooks.PreToolUse.map((e) => e.matcher)).toEqual(['ExitPlanMode', 'Task'])
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*')
    expect(settings.hooks.PermissionRequest[0].matcher).toBe('*')
    // Lifecycle hooks are matcher-less (match all invocations).
    expect(settings.hooks.Stop[0].matcher).toBeUndefined()
    expect(settings.hooks.SubagentStart[0].matcher).toBeUndefined()

    // Path buckets (the label carried in status metadata).
    expect(settings.hooks.SubagentStop[0].hooks[0].url).toContain('/subagent')
    expect(settings.hooks.StopFailure[0].hooks[0].url).toContain('/stop')
    expect(settings.hooks.PreCompact[0].hooks[0].url).toContain('/compact')
    expect(settings.hooks.Notification[0].hooks[0].url).toContain('/event')
    expect(settings.hooks.Elicitation[0].hooks[0].url).toContain('/permission')
  })
})

describe('ClaudeHookServer HTTP round-trip', () => {
  it('publishes mapped hook status through the backend event bus without legacy renderer IPC sends', async () => {
    const { port } = await getClaudeHookServer()
    backendManagerMocks.publishDesktopBackendEvent.mockResolvedValue(true)

    const response = await postHook(port, 'hive-session-1', 'session', {
      hook_event_name: 'SessionStart'
    })

    expect(response).toEqual({ status: 200, text: '{}' })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        {
          sessionId: 'hive-session-1',
          status: 'completed',
          metadata: { hookEventName: 'SessionStart', hookPath: 'session' }
        }
      )
    })
  })

  it('publishes ExitPlanMode raw plan text through the backend event bus', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: {
        plan: '# Plan\n\n1. Add CLI card.'
      }
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        {
          sessionId: 'hive-session-1',
          status: 'plan_ready',
          metadata: {
            hookEventName: 'PreToolUse',
            hookPath: 'tool',
            toolName: 'ExitPlanMode',
            plan: '# Plan\n\n1. Add CLI card.'
          }
        }
      )
    })
  })

  it('forwards ExitPlanMode rejection as planning so plan followups can resume review', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'ExitPlanMode',
      tool_response: {
        content: 'Please revise the plan before implementing.'
      }
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        {
          sessionId: 'hive-session-1',
          status: 'planning',
          metadata: {
            hookEventName: 'PostToolUseFailure',
            hookPath: 'tool',
            toolName: 'ExitPlanMode'
          }
        }
      )
    })
  })

  it('does not publish duplicate sequential statuses for the same session', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    })
  })

  it('publishes again after the session status changes', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })
    await postHook(port, 'hive-session-1', 'permission', {
      hook_event_name: 'PermissionRequest'
    })
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(3)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenNthCalledWith(
      3,
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
      }
    )
  })

  it('dedupes direct PTY-exit fallback after an equivalent hook status', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    })
    publishClaudeCliStatus({
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { reason: 'pty_exit' }
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'completed',
        metadata: { hookEventName: 'Stop', hookPath: 'stop' }
      }
    )
  })

  it('does not publish completed for a Stop fired while a sub-agent is running', async () => {
    const { port } = await getClaudeHookServer()
    backendManagerMocks.publishDesktopBackendEvent.mockResolvedValue(true)

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })
    await postHook(port, 'hive-session-1', 'subagent', { hook_event_name: 'SubagentStart' })
    // Main turn ends while the sub-agent is still running — must stay 'working'
    // (deferred), so this posts nothing new past the initial 'working'.
    await postHook(port, 'hive-session-1', 'stop', { hook_event_name: 'Stop' })
    // Only the last SubagentStop flips the session to 'completed'.
    await postHook(port, 'hive-session-1', 'subagent', { hook_event_name: 'SubagentStop' })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(2)
    })
    // First publish is the working from UserPromptSubmit; the deferred Stop is
    // deduped away, so completed appears exactly once and only at the end.
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenNthCalledWith(
      2,
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'completed',
        metadata: { hookEventName: 'SubagentStop', hookPath: 'subagent' }
      }
    )
  })

  it('fast-acks MessageDisplay without publishing or routing', async () => {
    const { port } = await getClaudeHookServer()
    backendManagerMocks.publishDesktopBackendEvent.mockResolvedValue(true)

    const response = await postHook(port, 'hive-session-1', 'event', {
      hook_event_name: 'MessageDisplay',
      text: 'streaming chunk…'
    })

    expect(response).toEqual({ status: 200, text: '{}' })
    // No status event of any kind for a per-chunk display hook.
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('ignores unknown event names without publishing status events', async () => {
    const { port } = await getClaudeHookServer()

    const response = await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'BogusEvent'
    })

    expect(response).toEqual({ status: 200, text: '{}' })
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('handles malformed JSON without publishing status events', async () => {
    const { port } = await getClaudeHookServer()

    const response = await postHook(port, 'hive-session-1', 'start', 'not json')

    expect(response).toEqual({ status: 200, text: '{}' })
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('rejects non-POST requests without publishing status events', async () => {
    const { port } = await getClaudeHookServer()

    const response = await getHook(port, 'hive-session-1', 'start')

    expect(response).toEqual({ status: 405, text: '{}' })
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })
})
