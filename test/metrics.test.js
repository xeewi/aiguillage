// Unit tests for lib/metrics.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// store.js reads AIGUILLAGE_HOME at import time: point it at a throwaway dir first.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cgmet-')))
process.env.AIGUILLAGE_HOME = HOME
const { metric, readMetrics, summarize } = await import('../lib/metrics.js')

test('summarize: costs per workspace and for the aiguilleur, turns, merges, permission wait, pushes per day', () => {
  const now = Date.parse('2026-11-20T12:00:00Z'), d = 86_400_000
  const s = summarize([
    { t: now - 3 * d, kind: 'turn', ws: 'a', ok: true, ms: 1000, cost: 0.5 },
    { t: now - 2 * d, kind: 'turn', ws: 'a', ok: false, ms: 1000, cost: 0.25 },
    { t: now - d, kind: 'turn', ws: 'aiguilleur', ok: true, ms: 10, cost: 0.05 },
    { t: now - d, kind: 'merge', ws: 'a', ok: false, conflict: true },
    { t: now - d, kind: 'merge', ws: 'a', ok: true, conflict: false },
    { t: now - d, kind: 'permission', ws: 'a', tool: 'Bash', allow: true, waitMs: 1000 },
    { t: now - d, kind: 'permission', ws: 'a', tool: 'Bash', allow: false, waitMs: 3000 },
    { t: now - d, kind: 'permission', ws: 'a', tool: 'Bash', allow: true, waitMs: 9000 },
    { t: now - d, kind: 'push' }, { t: now - d, kind: 'push' }, { t: now - d, kind: 'push' },
  ], now)
  assert.equal(s.days, 3)
  assert.deepEqual(s.cost, { total: 0.8, aiguilleur: 0.05, byWs: { a: 0.75, aiguilleur: 0.05 } })
  assert.deepEqual(s.turns, { n: 3, failed: 1 })
  assert.deepEqual(s.merges, { n: 2, conflicts: 1 })
  assert.deepEqual(s.permissions, { n: 3, denied: 1, medianWaitMs: 3000 })
  assert.equal(s.pushesPerDay, 1)
})

test('summarize: reports with a block and red checks', () => {
  const now = 1e12
  const s = summarize([{ t: now, kind: 'report', block: true }, { t: now, kind: 'report', block: false }, { t: now, kind: 'check', ok: false }], now)
  assert.deepEqual(s.reports, { n: 2, withBlock: 1 })
  assert.deepEqual(s.checks, { n: 1, red: 1 })
})

test('readMetrics skips half-written lines and older events', () => {
  const t0 = Date.now()
  appendFileSync(join(HOME, 'metrics.jsonl'), JSON.stringify({ t: t0 - 1000, kind: 'old' }) + '\n{"t":\n')
  metric('push')
  const evs = readMetrics(t0)
  assert.deepEqual(evs.map(e => e.kind), ['push'])
})

test('summarize of nothing is all zeros, days 1', () => {
  const s = summarize([], Date.now())
  assert.equal(s.days, 1)
  assert.deepEqual(s.cost, { total: 0, aiguilleur: 0, byWs: {} })
  assert.deepEqual(s.turns, { n: 0, failed: 0 })
  assert.deepEqual(s.permissions, { n: 0, denied: 0, medianWaitMs: 0 })
  assert.equal(s.pushesPerDay, 0)
})
