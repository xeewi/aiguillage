import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo } from './helpers.mjs'
import { snapshot } from '../lib/git.js'
import { testFiles, inspect, DEFAULT_TEST_GLOBS } from '../lib/review.js'

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
  assert.deepEqual(await inspect({ path: repo }, cp, { testGlobs: ['spec/**'] }), { testsTouched: ['spec/x.rb'] })
  assert.deepEqual(await inspect({ path: repo }, null), { testsTouched: [] })
})
