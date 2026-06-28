import { describe, expect, it } from 'vitest'

import {
  parseCpuTime,
  parsePsOutput,
  classifyProcess,
  resolveAppRoot,
  collectMonitoredPids,
  computeCpuPct,
  computeProcessFlags,
  findOrphans,
  RSS_GROWTH_MIN_BYTES,
  type RawProcess
} from './system-monitor'
import type { MonitorProcess } from '../../shared/system-monitor-events'

describe('parseCpuTime', () => {
  it('parses MM:SS and MM:SS.ss (macOS)', () => {
    expect(parseCpuTime('0:00')).toBe(0)
    expect(parseCpuTime('1:30')).toBe(90)
    expect(parseCpuTime('12:34.56')).toBeCloseTo(754.56, 2)
  })

  it('parses HH:MM:SS', () => {
    expect(parseCpuTime('01:02:03')).toBe(3723)
  })

  it('parses DD-HH:MM:SS (Linux multi-day)', () => {
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
  })

  it('returns 0 for empty or garbage input', () => {
    expect(parseCpuTime('')).toBe(0)
    expect(parseCpuTime('abc')).toBe(0)
  })
})

describe('parsePsOutput', () => {
  const fixture = [
    '  PID  PPID    RSS        TIME COMMAND',
    '  100     1  20480     0:01.50 /Applications/Hive.app/Contents/MacOS/Hive',
    '  200   100  10240       01:02 node /Users/x/out/server/bin.js',
    ''
  ].join('\n')

  it('skips the header row and parses each process line', () => {
    const rows = parsePsOutput(fixture)
    expect(rows).toHaveLength(2)
  })

  it('converts RSS from KiB to bytes and time to seconds', () => {
    const [first, second] = parsePsOutput(fixture)
    expect(first).toEqual({
      pid: 100,
      ppid: 1,
      rss: 20480 * 1024,
      cpuSec: 1.5,
      command: '/Applications/Hive.app/Contents/MacOS/Hive'
    })
    expect(second.pid).toBe(200)
    expect(second.ppid).toBe(100)
    expect(second.cpuSec).toBe(62)
    expect(second.command).toBe('node /Users/x/out/server/bin.js')
  })
})

describe('classifyProcess', () => {
  it('classifies Electron subprocess types via --type flags', () => {
    expect(classifyProcess('/path/Hive --type=renderer --foo').type).toBe('electron-renderer')
    expect(classifyProcess('/path/Hive --type=gpu-process').type).toBe('electron-gpu')
    const util = classifyProcess('/path/Hive --type=utility --utility-sub-type=network.mojom.NetworkService')
    expect(util.type).toBe('electron-utility')
    expect(util.label).toBe('Utility: network.mojom.NetworkService')
  })

  it('classifies the RPC server child', () => {
    expect(classifyProcess('node /Users/x/out/server/bin.js').type).toBe('server')
  })

  it('classifies MCP servers and agent CLIs', () => {
    const mcp = classifyProcess('node /x/@delorenj/mcp-server-trello/build/index.js')
    expect(mcp.type).toBe('mcp-server')
    expect(mcp.label).toContain('trello')
    expect(classifyProcess('/usr/local/bin/claude --print').type).toBe('claude')
    expect(classifyProcess('/opt/bin/codex serve').type).toBe('codex')
    expect(classifyProcess('/usr/bin/opencode run').type).toBe('opencode')
  })

  it('classifies git, the Electron main binary, shells, and falls back to other', () => {
    expect(classifyProcess('/usr/bin/git fetch origin').type).toBe('git')
    expect(classifyProcess('/Applications/Hive.app/Contents/MacOS/Hive').type).toBe('electron-main')
    expect(classifyProcess('-zsh').type).toBe('shell')
    expect(classifyProcess('/bin/bash -l').type).toBe('shell')
    const other = classifyProcess('/usr/sbin/cfprefsd')
    expect(other.type).toBe('other')
    expect(other.label).toBe('cfprefsd')
  })
})

describe('resolveAppRoot', () => {
  it('climbs through Electron/node ancestors and stops at the topmost app process', () => {
    const byPid = new Map<number, { ppid: number; command: string }>([
      [1, { ppid: 0, command: 'launchd' }],
      [10, { ppid: 1, command: '/Applications/Hive.app/Contents/MacOS/Hive' }],
      [20, { ppid: 10, command: '/Applications/Hive.app/Contents/MacOS/Hive --type=utility' }],
      [30, { ppid: 20, command: 'node /x/out/server/bin.js' }]
    ])
    // Server's ppid is the utility process (20); root should climb to the main (10).
    expect(resolveAppRoot(byPid, 20)).toBe(10)
  })

  it('stops at a non-app ancestor (the login shell)', () => {
    const byPid = new Map<number, { ppid: number; command: string }>([
      [1, { ppid: 0, command: 'launchd' }],
      [10, { ppid: 1, command: '-zsh' }],
      [20, { ppid: 10, command: '/Applications/Hive.app/Contents/MacOS/Hive' }]
    ])
    expect(resolveAppRoot(byPid, 20)).toBe(20)
  })
})

describe('collectMonitoredPids', () => {
  const procs: RawProcess[] = [
    { pid: 10, ppid: 1, rss: 0, cpuSec: 0, command: '/Applications/Hive.app/Contents/MacOS/Hive' },
    { pid: 20, ppid: 10, rss: 0, cpuSec: 0, command: '/path/Hive --type=renderer' },
    { pid: 30, ppid: 20, rss: 0, cpuSec: 0, command: 'node /x/out/server/bin.js' },
    { pid: 99, ppid: 1, rss: 0, cpuSec: 0, command: 'node /x/mcp-server-trello/build/index.js' },
    { pid: 88, ppid: 1, rss: 0, cpuSec: 0, command: '/usr/sbin/cfprefsd' }
  ]

  it('includes the root, all descendants, and app-matching orphans', () => {
    const monitored = collectMonitoredPids(procs, 10)
    expect([...monitored].sort((a, b) => a - b)).toEqual([10, 20, 30, 99])
  })

  it('excludes unrelated orphans', () => {
    expect(collectMonitoredPids(procs, 10).has(88)).toBe(false)
  })
})

describe('computeCpuPct', () => {
  it('returns 0 on the first observation (no previous sample)', () => {
    expect(computeCpuPct(10, undefined, 2)).toBe(0)
  })

  it('derives instantaneous percent from the cumulative-seconds delta', () => {
    expect(computeCpuPct(12, 10, 2)).toBe(100)
    expect(computeCpuPct(11, 10, 3)).toBe(33.33)
  })

  it('clamps non-positive deltas and non-positive wall time to 0', () => {
    expect(computeCpuPct(10, 12, 2)).toBe(0)
    expect(computeCpuPct(12, 10, 0)).toBe(0)
  })
})

describe('computeProcessFlags', () => {
  it('flags HIGH cpu', () => {
    expect(computeProcessFlags({ cpuPct: 85, rss: 1024, ppid: 200 }, 1024)).toEqual(['HIGH'])
  })

  it('flags ORPHAN when reparented to PID 1', () => {
    expect(computeProcessFlags({ cpuPct: 5, rss: 1024, ppid: 1 }, 1024)).toEqual(['ORPHAN'])
  })

  it('flags RSS_GROWTH past the floor and growth factor', () => {
    const baseline = 300 * 1024 * 1024
    const grown = 600 * 1024 * 1024
    expect(grown).toBeGreaterThan(RSS_GROWTH_MIN_BYTES)
    expect(computeProcessFlags({ cpuPct: 5, rss: grown, ppid: 200 }, baseline)).toEqual([
      'RSS_GROWTH'
    ])
  })

  it('does not flag RSS_GROWTH below the absolute floor', () => {
    const baseline = 10 * 1024 * 1024
    const grown = 100 * 1024 * 1024 // 10x growth but under the 400MB floor
    expect(computeProcessFlags({ cpuPct: 5, rss: grown, ppid: 200 }, baseline)).toEqual([])
  })

  it('combines HIGH and ORPHAN', () => {
    expect(computeProcessFlags({ cpuPct: 95, rss: 1024, ppid: 1 }, 1024)).toEqual(['HIGH', 'ORPHAN'])
  })
})

describe('findOrphans', () => {
  it('filters to processes flagged ORPHAN', () => {
    const processes = [
      { pid: 1, flags: ['HIGH'] },
      { pid: 2, flags: ['ORPHAN'] },
      { pid: 3, flags: [] },
      { pid: 4, flags: ['HIGH', 'ORPHAN'] }
    ] as unknown as MonitorProcess[]
    expect(findOrphans(processes).map((p) => p.pid)).toEqual([2, 4])
  })
})
