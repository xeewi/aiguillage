// Local measures: one JSON line per event, kept on this Mac only (never sent anywhere).
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './store.js'

const METRICS = join(HOME, 'metrics.jsonl')

// ponytail: append-only, read whole on each GET; rotate by month if the file grows past a few MB.
export function metric(kind, data) {
  try { appendFileSync(METRICS, JSON.stringify({ t: Date.now(), kind, ...data }) + '\n') }
  catch (e) { console.error('metrics:', e.message) } // a measure is never worth failing the action it measures
}

export function readMetrics(since) {
  if (!existsSync(METRICS)) return []
  // A line half-written during a crash is skipped, like readLog.
  return readFileSync(METRICS, 'utf8').split('\n').flatMap(l => { try { const e = JSON.parse(l); return e.t >= since ? [e] : [] } catch { return [] } })
}

const cents = x => Math.round(x * 100) / 100
const sum = (a, f) => a.reduce((s, e) => s + f(e), 0)
const median = a => { const s = a.toSorted((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0 }

export function summarize(evs, now) {
  const of = kind => evs.filter(e => e.kind === kind)
  const turns = of('turn'), merges = of('merge'), perms = of('permission'), reports = of('report'), checks = of('check')
  const byWs = {}
  for (const e of turns) byWs[e.ws] = (byWs[e.ws] ?? 0) + (e.cost ?? 0)
  for (const k in byWs) byWs[k] = cents(byWs[k])
  const first = evs.reduce((m, e) => Math.min(m, e.t), now) // not Math.min(...spread): a long history overflows the call stack
  const days = Math.max(1, Math.ceil((now - first) / 86_400_000))
  return {
    days,
    cost: { total: cents(sum(turns, e => e.cost ?? 0)), aiguilleur: byWs.aiguilleur ?? 0, byWs },
    turns: { n: turns.length, failed: turns.filter(e => !e.ok).length },
    merges: { n: merges.length, conflicts: merges.filter(e => e.conflict).length },
    permissions: { n: perms.length, denied: perms.filter(e => !e.allow).length, medianWaitMs: median(perms.map(e => e.waitMs ?? 0)) },
    pushesPerDay: cents(of('push').length / days),
    reports: { n: reports.length, withBlock: reports.filter(e => e.block).length },
    checks: { n: checks.length, red: checks.filter(e => !e.ok).length },
  }
}
