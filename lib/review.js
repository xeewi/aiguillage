// What a turn left behind, looked at from outside: the facts the report carries besides the agent's own words.
import { spawn } from 'node:child_process'
import * as G from './git.js'
import { save } from './store.js'
import { envFor } from './agent.js'
import { metric } from './metrics.js'

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/test/**', '**/tests/**', '**/__tests__/**']

// Test files that differ between a checkpoint tree and the working copy now (untracked included: snapshot adds them).
export async function testFiles(cwd, fromTree, globs) {
  if (!globs.length) return []
  const { tree } = await G.snapshot(cwd)
  const out = await G.git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-only', fromTree, tree, '--', ...globs.map(g => `:(glob)${g}`)])
  return out.split('\n').filter(Boolean)
}

export const CHECK_TIMEOUT = Number(process.env.AIGUILLAGE_CHECK_TIMEOUT_MS) || 600_000
// ponytail: bounds the git work around a turn (not the check), so a hung git can't stall a workspace's reports forever.
const INSPECT_TIMEOUT = 60_000

// Workspaces whose check is running now (runtime only, never saved); the page reads it through the state.
export const checking = new Set()
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
    const timer = setTimeout(() => { over = true; try { process.kill(-p.pid, 'SIGKILL') } catch {} }, timeout)
    const end = (ok, code) => { clearTimeout(timer); resolve({ ok, code, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-3000), ms: Date.now() - t0, tree }) }
    p.on('error', e => { out += e.message; end(false, null) })
    p.on('close', code => end(!over && code === 0, over ? null : code))
  })
}

// Runs and keeps the result on the workspace (the page and the merge gate read ws.check).
export async function runSaved(ws, command) {
  checking.add(ws.id); onChange()
  try {
    const r = await runCheck(ws, command, envFor(ws))
    ws.check = { ok: r.ok, code: r.code, ms: r.ms, tree: r.tree, at: Date.now(), out: r.out }
    save(); metric('check', { ws: ws.id, ok: r.ok, ms: r.ms })
    return ws.check
  } finally { checking.delete(ws.id); onChange() }
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
  if (!command || ws.check?.tree === tree) return { testsTouched, check: null }
  return { testsTouched, check: await runSaved(ws, command) }
}
