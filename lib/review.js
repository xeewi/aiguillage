// What a turn left behind, looked at from outside: the facts the report carries besides the agent's own words.
import { spawn } from 'node:child_process'
import * as G from './git.js'
import { save } from './store.js'
import { envFor } from './agent.js'
import { metric } from './metrics.js'

// ponytail: one fixed ceiling for every repo's check (10 min, env override); per-repo values in settings.toml if needed.
export const CHECK_TIMEOUT = Number(process.env.AIGUILLAGE_CHECK_TIMEOUT_MS) || 600_000

// ponytail: overlap at file level, not a real merge simulation; move to `git merge-tree --write-tree` if false alarms get annoying.
// Scanned every 10 min and after each turn.
export const OVERLAP_EVERY = 10 * 60_000

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/test/**', '**/tests/**', '**/__tests__/**']

// Test files that differ between a checkpoint tree and toTree, by default the working copy now (untracked included:
// snapshot adds them).
export async function testFiles(cwd, fromTree, globs, toTree) {
  if (!globs.length) return []
  toTree ??= (await G.snapshot(cwd)).tree
  const out = await G.git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-only', fromTree, toTree, '--', ...globs.map(g => `:(glob)${g}`)])
  return out.split('\n').filter(Boolean)
}

// Workspace id -> its check running now (runtime only, never saved); the page reads it through the state.
// Each one's promise carries .tree: a promise of the tree it runs on.
export const checking = new Map()
let onChange = () => {}
export const wire = fn => { onChange = fn }
// Every check process running now, by its kill: Aiguillage quitting kills them (killChecks, server.js shutdown); their
// result says killed (runSaved doesn't keep it: it says nothing about the files).
const procs = new Set()
export const killChecks = () => { for (const quit of procs) quit() }

// A stored result says something about the files only if it ran on this very tree with this very command.
export const fresh = (check, tree, command) => !!check && check.tree === tree && check.command === command

// Runs the repo's check script in the worktree; tree: what it was run on (snapshot taken before, unless given).
export async function runCheck(ws, command, env, { timeout = CHECK_TIMEOUT, tree } = {}) {
  tree ??= (await G.snapshot(ws.path)).tree
  const t0 = Date.now()
  return new Promise(resolve => {
    let out = '', over = false, killed = false
    const p = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd: ws.path, env, detached: true })
    const add = d => { out = (out + d).slice(-20_000) }
    p.stdout.on('data', add); p.stderr.on('data', add)
    // The whole process group: a shell leaves its children (and the open pipe) behind otherwise.
    const timer = setTimeout(() => { over = true; kill() }, timeout)
    const end = (ok, code) => { clearTimeout(timer); procs.delete(quit); resolve({ ok, code, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-3000), ms: Date.now() - t0, tree, ...killed && { killed } }) }
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL') } catch {} } // ESRCH: already gone
    const quit = () => { killed = true; kill() }
    procs.add(quit)
    let done = false
    const finish = code => { if (!done) { done = true; end(!over && code === 0, over ? null : code) } }
    p.on('error', e => { out += e.message; done = true; end(false, null) })
    // The shell has exited: its leftover children must not hold the check open (or live on). 'close' brings the last output.
    // Its verdict is in: the timeout no longer applies (it could otherwise turn a pass into a fail while 'close' waits).
    p.on('exit', code => { clearTimeout(timer); kill(); setTimeout(finish, 1000, code).unref(); p.once('close', () => finish(code)) })
  })
}

// Runs and keeps the result on the workspace (the page and the merge gate read ws.check).
// A second request while one runs gets the running one (no two runs on a worktree, no lost result).
export function runSaved(ws, command) {
  if (checking.has(ws.id)) return checking.get(ws.id)
  const tree = G.snapshot(ws.path).then(s => s.tree)
  const p = (async () => {
    const r = await runCheck(ws, command, envFor(ws), { tree: await tree })
    if (r.killed) return r
    ws.check = { ok: r.ok, code: r.code, ms: r.ms, tree: r.tree, command, at: Date.now(), out: r.out }; ws.checkStale = false
    save(); metric('check', { ws: ws.id, ok: r.ok, ms: r.ms })
    return ws.check
  })().finally(() => { checking.delete(ws.id); onChange() })
  p.tree = tree.catch(() => null); p.command = command
  checking.set(ws.id, p); onChange()
  return p
}

const bounded = p => {
  let timer
  return Promise.race([p, new Promise((_, no) => { timer = setTimeout(no, G.GIT_TIMEOUT, new Error('inspect: git took too long')) })]).finally(() => clearTimeout(timer))
}

// cp: the checkpoint taken before the turn's message (null: nothing to compare with). end: (a promise of) the tree the
// turn left (lib/agent.js endTree), so a next turn already at work can't lend it its test files; null: the files now.
// check: null without a command (or in a free session), or when nothing changed since the last one.
// ponytail: the report waits for the check; a 🧪 running notice first if checks often go over a minute.
export async function inspect(ws, cp, cfg = {}, end = null) {
  const command = ws.free ? null : cfg.check
  const [testsTouched, tree] = await bounded(Promise.all([
    cp ? Promise.resolve(end).then(to => testFiles(ws.path, cp.tree, cfg.testGlobs ?? DEFAULT_TEST_GLOBS, to)) : [],
    command ? G.snapshot(ws.path).then(s => s.tree) : null]))
  let check = null
  if (command && !fresh(ws.check, tree, command)) {
    // A check already running (Run check) on files from before the turn's last edits, or with another command: its
    // result, then one on these files with this command.
    const running = checking.get(ws.id)
    if (running && (await running.tree !== tree || running.command !== command)) await running.catch(() => {})
    check = await runSaved(ws, command)
  }
  // Whether the stored check is about the files as they are now (the board's 🧪❌, lib/remote.js); no check: stale.
  const stale = !fresh(ws.check, tree, command)
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
