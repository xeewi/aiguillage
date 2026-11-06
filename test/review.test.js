import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo, git } from './helpers.mjs'
import { snapshot } from '../lib/git.js'
import { testFiles, inspect, runCheck, changedFiles, overlaps, inScope, DEFAULT_TEST_GLOBS } from '../lib/review.js'

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
