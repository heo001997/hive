import { describe, expect, it } from 'vitest'
import {
  resolveRssBaseline,
  computeProcessFlags,
  RSS_BASELINE_WARMUP_MS,
  RSS_GROWTH_MIN_BYTES,
  RSS_GROWTH_FACTOR
} from './system-monitor'

const MB = 1024 * 1024

describe('resolveRssBaseline (RSS-growth warm-up)', () => {
  it('seeds the baseline to the current RSS the first time a pid is seen', () => {
    expect(resolveRssBaseline(undefined, 200 * MB, 0)).toBe(200 * MB)
  })

  it('tracks the high-water mark while still warming up', () => {
    // cold 200MB -> climbing to 500MB inside the warm-up window: baseline rises
    expect(resolveRssBaseline(200 * MB, 500 * MB, RSS_BASELINE_WARMUP_MS - 1)).toBe(500 * MB)
  })

  it('never lowers the baseline during warm-up', () => {
    // a transient dip below the mark must not reset the baseline downward
    expect(resolveRssBaseline(500 * MB, 300 * MB, 1_000)).toBe(500 * MB)
  })

  it('freezes the baseline once the warm-up window has elapsed', () => {
    // post-warm-up growth must not keep ratcheting the baseline via this path
    expect(resolveRssBaseline(500 * MB, 900 * MB, RSS_BASELINE_WARMUP_MS)).toBe(500 * MB)
  })
})

describe('warm-up baseline suppresses the cold-start false positive', () => {
  const ppid = 100

  it('does not flag RSS_GROWTH for a renderer settling to its warm working set', () => {
    // Renderer first sampled cold at 200MB, then settles to 784MB during warm-up.
    let baseline = resolveRssBaseline(undefined, 200 * MB, 0) // first sight
    baseline = resolveRssBaseline(baseline, 784 * MB, RSS_BASELINE_WARMUP_MS / 2) // warming
    const flags = computeProcessFlags({ cpuPct: 5, rss: 784 * MB, ppid }, baseline)
    expect(flags).not.toContain('RSS_GROWTH')
  })

  it('still flags a genuine leak that climbs past the warmed working set', () => {
    // Warmed to ~600MB, then leaks past 1.5x after the window has elapsed.
    let baseline = resolveRssBaseline(undefined, 600 * MB, 0)
    baseline = resolveRssBaseline(baseline, 600 * MB, RSS_BASELINE_WARMUP_MS) // frozen at 600MB
    const leaked = Math.ceil(600 * MB * RSS_GROWTH_FACTOR) + MB
    expect(leaked).toBeGreaterThanOrEqual(RSS_GROWTH_MIN_BYTES)
    const flags = computeProcessFlags({ cpuPct: 5, rss: leaked, ppid }, baseline)
    expect(flags).toContain('RSS_GROWTH')
  })
})
