import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo } from './helpers.mjs'
import { snapshot } from '../lib/git.js'
import { testFiles, inspect, runCheck, DEFAULT_TEST_GLOBS } from '../lib/review.js'

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
