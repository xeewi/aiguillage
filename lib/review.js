// What a turn left behind, looked at from outside: the facts the report carries besides the agent's own words.
import { spawn } from 'node:child_process'
import * as G from './git.js'
import { save } from './store.js'
import { envFor } from './agent.js'
import { metric } from './metrics.js'

// ponytail: one fixed ceiling for every repo's check (10 min, env override); per-repo values in settings.toml if needed.
export const CHECK_TIMEOUT = Number(process.env.AIGUILLAGE_CHECK_TIMEOUT_MS) || 600_000
// ponytail: bounds the git work around a turn (not the check), so a hung git can't stall a workspace's reports forever.
const INSPECT_TIMEOUT = 60_000

// ponytail: overlap at file level, not a real merge simulation; move to `git merge-tree --write-tree` if false alarms get annoying.
// Scanned every 10 min and after each turn.
export const OVERLAP_EVERY = 10 * 60_000

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/test/**', '**/tests/**', '**/__tests__/**']

// Test files that differ between a checkpoint tree and the working copy now (untracked included: snapshot adds them).
export async function testFiles(cwd, fromTree, globs) {
  if (!globs.length) return []
  const { tree } = await G.snapshot(cwd)
  const out = await G.git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-only', fromTree, tree, '--', ...globs.map(g => `:(glob)${g}`)])
  return out.split('\n').filter(Boolean)
}

// Workspace id -> its check running now (runtime only, never saved); the page reads it through the state.
export const checking = new Map()
let onChange = () => {}
export const wire = fn => { onChange = fn }

// Runs the repo's check script in the worktree; tree: what it was run on (snapshot taken before).
export async function runCheck(ws, command, env, { timeout = CHECK_TIMEOUT } = {}) {
  const { tree } = await G.snapshot(ws.path), t0 = Date.now()
  return new Promise(resolve => {
    let out = '', over = false
    const p = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd: ws.path, env, detached: true })
    const add = d => { out = (out + d).slice(-20_000) }
    p.stdout.on('data', add); p.stderr.on('data', add)
    // The whole process group: a shell leaves its children (and the open pipe) behind otherwise.
    const timer = setTimeout(() => { over = true; kill() }, timeout)
    const end = (ok, code) => { clearTimeout(timer); resolve({ ok, code, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-3000), ms: Date.now() - t0, tree }) }
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL') } catch {} } // ESRCH: already gone
    let done = false
    const finish = code => { if (!done) { done = true; end(!over && code === 0, over ? null : code) } }
    p.on('error', e => { out += e.message; done = true; end(false, null) })
    // The shell has exited: its leftover children must not hold the check open (or live on). 'close' brings the last output.
    p.on('exit', code => { kill(); setTimeout(finish, 1000, code).unref(); p.once('close', () => finish(code)) })
  })
}

// Runs and keeps the result on the workspace (the page and the merge gate read ws.check).
// A second request while one runs gets the running one (no two runs on a worktree, no lost result).
export function runSaved(ws, command) {
  if (checking.has(ws.id)) return checking.get(ws.id)
  const p = (async () => {
    const r = await runCheck(ws, command, envFor(ws))
    ws.check = { ok: r.ok, code: r.code, ms: r.ms, tree: r.tree, at: Date.now(), out: r.out }; ws.checkStale = false
    save(); metric('check', { ws: ws.id, ok: r.ok, ms: r.ms })
    return ws.check
  })().finally(() => { checking.delete(ws.id); onChange() })
  checking.set(ws.id, p); onChange()
  return p
}

const bounded = p => {
  let timer
  return Promise.race([p, new Promise((_, no) => { timer = setTimeout(no, INSPECT_TIMEOUT, new Error('inspect: git took too long')) })]).finally(() => clearTimeout(timer))
}

// cp: the checkpoint taken before the turn's message (null: nothing to compare with).
// check: null without a command (or in a free session), or when nothing changed since the last one.
// ponytail: the report waits for the check; a 🧪 running notice first if checks often go over a minute.
export async function inspect(ws, cp, cfg = {}) {
  const command = ws.free ? null : cfg.check
  const [testsTouched, tree] = await bounded(Promise.all([
    cp ? testFiles(ws.path, cp.tree, cfg.testGlobs ?? DEFAULT_TEST_GLOBS) : [],
    command ? G.snapshot(ws.path).then(s => s.tree) : null]))
  const check = command && ws.check?.tree !== tree ? await runSaved(ws, command) : null
  // Whether the stored check is about the files as they are now (the board's 🧪❌, lib/remote.js); no check: stale.
  const stale = ws.check?.tree !== tree
  if (ws.checkStale !== stale) { ws.checkStale = stale; save() }
  return { testsTouched, check }
}

// Everything the workspace changed vs. its fork point (committed, edited, untracked): same base as G.diff.
export async function changedFiles(cwd, base) {
  const mb = (await G.git(cwd, ['merge-base', 'HEAD', base])).trim()
  const { tree } = await G.snapshot(cwd)
  return (await G.git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-only', mb, tree])).split('\n').filter(Boolean).sort()
}

// list: [{ id, files }] -> one { a, b, files } per couple that changed some of the same files.
export function overlaps(list) {
  const out = []
  list.forEach((x, i) => list.slice(i + 1).forEach(y => {
    const files = x.files.filter(f => y.files.includes(f)).sort()
    if (files.length) out.push({ a: x.id, b: y.id, files })
  }))
  return out
}

// The files that equal a scope entry or sit under it.
// Entries are normalized: './src/', 'src/**' and 'src' are the same.
export const inScope = (files, scope) => {
  const dirs = scope.map(s => s.replace(/^\.\//, '').replace(/(\/\*\*)?\/*$/, ''))
  return files.filter(f => dirs.some(s => f === s || f.startsWith(s + '/')))
}
