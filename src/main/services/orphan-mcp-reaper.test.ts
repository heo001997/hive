import { describe, expect, it } from 'vitest'

import {
  parseProcRows,
  environIncludesManagedMarker,
  MCP_COMMAND_PATTERN,
  CLAUDE_COMMAND_PATTERN,
  CODEX_COMMAND_PATTERN,
  OPENCODE_COMMAND_PATTERN,
  AGENT_CLI_COMMAND_PATTERN,
  HIVE_MANAGED_PTY_ENV
} from './orphan-mcp-reaper'

describe('parseProcRows', () => {
  it('parses pid/ppid/command rows and preserves spaces in the command', () => {
    const out = ['  123     1 /usr/bin/claude --flag a b', '456   123 node /x/mcp-server-trello.js'].join(
      '\n'
    )
    expect(parseProcRows(out)).toEqual([
      { pid: 123, ppid: 1, command: '/usr/bin/claude --flag a b' },
      { pid: 456, ppid: 123, command: 'node /x/mcp-server-trello.js' }
    ])
  })

  it('drops the header line and blank lines (no leading digits)', () => {
    const out = ['  PID  PPID COMMAND', '', '   7   1 claude'].join('\n')
    expect(parseProcRows(out)).toEqual([{ pid: 7, ppid: 1, command: 'claude' }])
  })
})

describe('environIncludesManagedMarker', () => {
  it('matches the marker at a NUL boundary (Linux /proc environ shape)', () => {
    expect(environIncludesManagedMarker(`PATH=/usr/bin\0${HIVE_MANAGED_PTY_ENV}=1\0TERM=xterm`)).toBe(
      true
    )
  })

  it('matches the marker at a space boundary (macOS ps -E shape)', () => {
    expect(environIncludesManagedMarker(`claude PATH=/bin ${HIVE_MANAGED_PTY_ENV}=1 TERM=xterm`)).toBe(
      true
    )
  })

  it('matches the marker at the very start of the block', () => {
    expect(environIncludesManagedMarker(`${HIVE_MANAGED_PTY_ENV}=1 PATH=/bin`)).toBe(true)
  })

  it('does NOT match the marker as a substring of another variable', () => {
    expect(environIncludesManagedMarker('SOME_HIVE_MANAGED_PTY=1')).toBe(false)
    expect(environIncludesManagedMarker('XHIVE_MANAGED_PTY=1')).toBe(false)
  })

  it('is false when the marker is absent', () => {
    expect(environIncludesManagedMarker('PATH=/usr/bin TERM=xterm')).toBe(false)
  })
})

describe('agent-CLI command patterns', () => {
  it('CLAUDE matches claude / claude-code but not unrelated tokens', () => {
    expect(CLAUDE_COMMAND_PATTERN.test('/usr/local/bin/claude --resume')).toBe(true)
    expect(CLAUDE_COMMAND_PATTERN.test('node /x/claude-code/cli.js')).toBe(true)
    expect(CLAUDE_COMMAND_PATTERN.test('/x/claudeless-thing')).toBe(false)
  })

  it('CODEX and OPENCODE match their CLIs', () => {
    expect(CODEX_COMMAND_PATTERN.test('/usr/bin/codex chat')).toBe(true)
    expect(OPENCODE_COMMAND_PATTERN.test('opencode run')).toBe(true)
  })

  it('AGENT_CLI_COMMAND_PATTERN matches any agent CLI but not MCP servers or git', () => {
    expect(AGENT_CLI_COMMAND_PATTERN.test('/usr/bin/claude')).toBe(true)
    expect(AGENT_CLI_COMMAND_PATTERN.test('codex')).toBe(true)
    expect(AGENT_CLI_COMMAND_PATTERN.test('opencode')).toBe(true)
    expect(AGENT_CLI_COMMAND_PATTERN.test('node /x/mcp-server-trello/build/index.js')).toBe(false)
    expect(AGENT_CLI_COMMAND_PATTERN.test('git rebase -i')).toBe(false)
  })

  it('MCP pattern matches MCP servers but not agent CLIs', () => {
    expect(MCP_COMMAND_PATTERN.test('npm exec @delorenj/mcp-server-trello')).toBe(true)
    expect(MCP_COMMAND_PATTERN.test('node @modelcontextprotocol/server-x')).toBe(true)
    expect(MCP_COMMAND_PATTERN.test('/usr/bin/claude')).toBe(false)
  })
})
