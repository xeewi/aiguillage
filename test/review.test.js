import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo, git, waitFor, tmp, sleep } from './helpers.mjs'
import { snapshot } from '../lib/git.js'
// store.js reads AIGUILLAGE_HOME at import time (runSaved saves): point it at a throwaway dir first.
process.env.AIGUILLAGE_HOME = tmp('cgreview-')
const { testFiles, inspect, runCheck, runSaved, checking, killChecks, changedFiles, overlaps, inScope, DEFAULT_TEST_GLOBS } = await import('../lib/review.js')

const put = (repo, f, s) => { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), s) }

test('testFiles lists only the test files changed since the checkpoint, untracked ones included', async () => {
  const repo = makeRepo({ 'src/a.js': 'a', 'test/a.test.js': 'a' })
  const cp = await snapshot(repo)
  put(repo, 'src/a.js', 'b'); put(repo, 'test/a.test.js', 'b'); put(repo, 'test/new.test.js', 'n')
  assert.deepEqual((await testFiles(repo, cp.tree, DEFAULT_TEST_GLOBS)).sort(), ['test/a.test.js', 'test/new.test.js'])
})

test('custom globs replace the defaults', async () => {
  const repo = makeRepo({ 'spec/x.rb': 'a', 'test/a.test.js': 'a' })
  const cp = await snapshot(repo)
  put(repo, 'spec/x.rb', 'b'); put(repo, 'test/a.test.js', 'b')
  assert.deepEqual(await testFiles(repo, cp.tree, ['spec/**']), ['spec/x.rb'])
  assert.deepEqual(await inspect({ path: repo }, cp, { testGlobs: ['spec/**'] }), { testsTouched: ['spec/x.rb'], check: null })
  assert.deepEqual(await inspect({ path: repo }, null), { testsTouched: [], check: null })
})

test('runCheck: exit 0 passes, exit 1 fails with the tail of the output, a timeout fails', async () => {
  const ws = { path: makeRepo({ 'a.txt': 'a' }) }
  const ok = await runCheck(ws, 'echo ok', process.env)
  assert.equal(ok.ok, true)
  assert.match(ok.tree, /^[0-9a-f]{40}$/)
  const r = await runCheck(ws, 'echo boom; exit 1', process.env)
  assert.deepEqual([r.ok, r.code, r.out.trim()], [false, 1, 'boom'])
  const t = await runCheck(ws, 'sleep 5', process.env, { timeout: 200 })
  assert.deepEqual([t.ok, t.code], [false, null])
  assert.equal((await runCheck(ws, `printf '\\033[31mred\\033[0m'`, process.env)).out, 'red')
})

test('runCheck: a check that exits 0 but leaves a background child passes at once and the child is killed', async () => {
  const ws = { path: makeRepo({ 'a.txt': 'a' }) }
  const t0 = Date.now()
  const r = await runCheck(ws, 'sleep 3 & echo hi; exit 0', process.env, { timeout: 1500 })
  assert.deepEqual([r.ok, r.code], [true, 0])
  assert.ok(Date.now() - t0 < 1400, `took ${Date.now() - t0} ms`)
})

const gone = pid => { try { process.kill(pid, 0); return false } catch (e) { return e.code === 'ESRCH' } }

test('runCheck: the background child is really killed, its pid gone once the check returns', async () => {
  const ws = { path: makeRepo({ 'a.txt': 'a' }) }, pidFile = join(tmp(), 'pid')
  const r = await runCheck(ws, `sleep 30 & echo $! > ${pidFile}; exit 0`, process.env)
  assert.equal(r.ok, true)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await waitFor(() => gone(pid), { timeout: 2000, what: `pid ${pid} gone` })
})

test("runCheck: the shell's exit settles the verdict; the timeout can't fire while the output pipe drains", async () => {
  const ws = { path: makeRepo({ 'a.txt': 'a' }) }
  // A child in a process group of its own (given time to leave the shell's) holds the pipe open past the kill: 'close'
  // never comes, the 1 s fallback ends it, after the timeout's moment.
  const r = await runCheck(ws, `perl -e 'setpgrp(0, 0); sleep 3' & sleep 0.3; exit 0`, process.env, { timeout: 600 })
  assert.deepEqual([r.ok, r.code], [true, 0])
})

test('killChecks: the checks still running when Aiguillage quits are killed, their process group with them', async () => {
  const ws = { path: makeRepo({ 'a.txt': 'a' }) }, pidFile = join(tmp(), 'pid')
  const t0 = Date.now()
  const p = runCheck(ws, `sleep 30 & echo $! > ${pidFile}; wait`, process.env)
  const pid = await waitFor(() => Number(readFileSync(pidFile, 'utf8')), { what: 'the check started' })
  killChecks()
  const r = await p
  assert.equal(r.ok, false)
  assert.ok(Date.now() - t0 < 5000)
  await waitFor(() => gone(pid), { timeout: 2000, what: `pid ${pid} gone` })
})

test('a check killed because Aiguillage quits is not saved as a red result', async () => {
  const ws = { id: 'quit', path: makeRepo({ 'a.txt': 'a' }) }
  const p = runSaved(ws, 'sleep 30')
  await p.tree; await sleep(200) // spawned
  killChecks()
  await p
  assert.equal(ws.check, undefined)
})

test('inspect does not reuse a running check of another command, even on the same files', async () => {
  const ws = { id: 'cmd', path: makeRepo({ 'a.txt': 'a' }) }
  const old = runSaved(ws, 'sleep 1; exit 1')
  assert.ok(checking.has(ws.id))
  const { check } = await inspect(ws, null, { check: 'true' })
  assert.deepEqual([check.command, check.ok], ['true', true])
  assert.equal((await old).ok, false)
})

test('overlaps: one pair per couple with the files they share, sorted', () => {
  assert.deepEqual(overlaps([{ id: 'a', files: ['x', 'y'] }, { id: 'b', files: ['y', 'z'] }, { id: 'c', files: ['q'] }]), [{ a: 'a', b: 'b', files: ['y'] }])
  assert.deepEqual(overlaps([{ id: 'a', files: ['z', 'b'] }, { id: 'b', files: ['b', 'z'] }]), [{ a: 'a', b: 'b', files: ['b', 'z'] }])
  assert.deepEqual(overlaps([]), [])
})

test('inScope: a file matches an entry exactly or under its folder', () => {
  assert.deepEqual(inScope(['src/a/b.js', 'lib/c.js', 'src/ab.js'], ['src/a']), ['src/a/b.js'])
  assert.deepEqual(inScope(['lib/c.js'], ['lib/c.js']), ['lib/c.js'])
  assert.deepEqual(inScope(['lib/c.js'], []), [])
  for (const e of ['./src/a', 'src/a/', 'src/a/**', './src/a/**']) assert.deepEqual(inScope(['src/a/b.js', 'src/ab.js'], [e]), ['src/a/b.js'], e)
})

test('changedFiles: committed, edited and untracked files since the fork point', async () => {
  const repo = makeRepo({ 'a.txt': 'a', 'b.txt': 'b' })
  const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  git(repo, 'checkout', '-qb', 'work')
  put(repo, 'c.txt', 'c'); git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c')
  put(repo, 'a.txt', 'a2'); put(repo, 'sub/new.txt', 'n')
  assert.deepEqual(await changedFiles(repo, base), ['a.txt', 'c.txt', 'sub/new.txt'])
  assert.deepEqual(await changedFiles(makeRepo({ 'a.txt': 'a' }), 'HEAD'), [])
})
