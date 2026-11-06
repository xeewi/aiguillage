import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { startServer, setup, makeRepo, git } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const diff = id => srv.api('GET', `/workspaces/${id}/diff`)
const commitIn = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }

test('diff: commits + uncommitted + untracked + unicode names, ignored excluded, status flag', async () => {
  const { w } = await setup(srv, { 'README.md': '# t\n', 'a.txt': 'one\n', '.gitignore': 'build/\n' })
  assert.deepEqual(await diff(w.id), { diff: '', status: '', checkFresh: false })

  writeFileSync(join(w.path, 'committed.txt'), 'in a commit\n'); commitIn(w.path, 'c1')
  let d = await diff(w.id)
  assert.match(d.diff, /\+in a commit/)
  assert.equal(d.status, '', 'everything committed')

  writeFileSync(join(w.path, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(w.path, 'café ñ.txt'), 'accent\n')
  mkdirSync(join(w.path, 'build')) // ignored dir
  writeFileSync(join(w.path, 'build/out.js'), 'ignored\n')
  d = await diff(w.id)
  assert.match(d.diff, /\+two/)
  assert.match(d.diff, /b\/café ñ\.txt/)
  assert.match(d.diff, /\+accent/)
  assert.doesNotMatch(d.diff, /out\.js|ignored/)
  assert.match(d.status, /a\.txt/)
  assert.equal(git(w.path, 'diff', '--cached', '--name-only'), '', 'computing the diff does not touch the real index')
})

test('diff: relative to the merge-base with origin/main, remote-only commits not shown', async () => {
  const repoPath = makeRepo({ 'README.md': '# o\n' }, { origin: true })
  const clone = join(dirname(repoPath), 'clone')
  git(dirname(repoPath), 'clone', '-q', join(dirname(repoPath), 'origin.git'), clone)
  writeFileSync(join(clone, 'remote.txt'), 'from remote\n'); commitIn(clone, 'remote'); git(clone, 'push', '-q', 'origin', 'main')
  const repo = await srv.api('POST', '/repos', { path: repoPath })
  const w = await srv.api('POST', '/workspaces', { repoId: repo.id })
  assert.equal(w.baseRef, 'origin/main')
  writeFileSync(join(w.path, 'mine.txt'), 'mine\n')
  const d = (await diff(w.id)).diff
  assert.match(d, /\+mine/)
  assert.doesNotMatch(d, /from remote/)
})

test('commit endpoint commits everything with the given message', async () => {
  const { w } = await setup(srv)
  writeFileSync(join(w.path, 'n.txt'), 'n\n')
  const r = await srv.api('POST', `/workspaces/${w.id}/commit`, { message: 'my message' })
  assert.match(r.message, /Commit/)
  assert.equal(git(w.path, 'log', '-1', '--format=%s'), 'my message')
  assert.equal(git(w.path, 'status', '--porcelain'), '')
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/commit`, { message: 'empty' }), e => e.status === 400)
})

test('merge: refused with uncommitted changes in the workspace', async () => {
  const { w } = await setup(srv)
  writeFileSync(join(w.path, 'x.txt'), 'x\n')
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/merge`), /uncommitted changes/)
})

test('merge: --no-ff merge commit when base is checked out in the main repo', async () => {
  const { repoPath, w } = await setup(srv)
  writeFileSync(join(w.path, 'feat.txt'), 'feat\n'); commitIn(w.path, 'feat')
  const r = await srv.api('POST', `/workspaces/${w.id}/merge`)
  assert.match(r.message, /merge commit/)
  assert.equal(git(repoPath, 'log', '-1', '--format=%P').split(' ').length, 2, 'a merge commit has two parents')
  assert.equal(readFileSync(join(repoPath, 'feat.txt'), 'utf8'), 'feat\n')
})

test('merge: fast-forwards main via fetch when the main repo is on another branch', async () => {
  const { repoPath, w } = await setup(srv)
  git(repoPath, 'checkout', '-q', '-b', 'elsewhere')
  writeFileSync(join(w.path, 'ff.txt'), 'ff\n'); commitIn(w.path, 'ff')
  const r = await srv.api('POST', `/workspaces/${w.id}/merge`)
  assert.match(r.message, /fast-forward/)
  assert.equal(git(repoPath, 'rev-parse', 'main'), git(w.path, 'rev-parse', 'HEAD'))
  assert.equal(git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'elsewhere', 'main checkout not switched')
  assert.ok(!existsSync(join(repoPath, 'ff.txt')))
})

test('merge: conflict → error, merge aborted, main repo left clean', async () => {
  const { repoPath, w } = await setup(srv, { 'README.md': 'base\n' })
  writeFileSync(join(w.path, 'README.md'), 'workspace\n'); commitIn(w.path, 'ws')
  writeFileSync(join(repoPath, 'README.md'), 'main\n'); commitIn(repoPath, 'main')
  const head = git(repoPath, 'rev-parse', 'HEAD')
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/merge`), /Conflict/)
  assert.equal(git(repoPath, 'status', '--porcelain'), '')
  assert.ok(!existsSync(join(repoPath, '.git/MERGE_HEAD')))
  assert.equal(git(repoPath, 'rev-parse', 'HEAD'), head)
  assert.equal(readFileSync(join(repoPath, 'README.md'), 'utf8'), 'main\n')
})

test('merge: refused when the main repo has uncommitted changes', async () => {
  const { repoPath, w } = await setup(srv)
  writeFileSync(join(w.path, 'f.txt'), 'f\n'); commitIn(w.path, 'f')
  writeFileSync(join(repoPath, 'README.md'), 'dirty\n')
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/merge`), /main repo/)
  assert.equal(readFileSync(join(repoPath, 'README.md'), 'utf8'), 'dirty\n', "user's edits untouched")
})

test('PR: clear error when the repo has no origin (nothing sent anywhere)', async () => {
  const { w } = await setup(srv)
  writeFileSync(join(w.path, 'f.txt'), 'f\n'); commitIn(w.path, 'f')
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/pr`), e => e.status === 400 && /origin/.test(e.message))
})
