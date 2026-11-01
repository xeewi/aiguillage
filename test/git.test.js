import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync, existsSync, realpathSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { git, isRepo, defaultBranch, addWorktree, removeWorktree, diff, snapshot, restore, busy } from '../lib/git.js'

test('worktree lifecycle, diff and checkpoints', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cgtest-')))
  const repo = join(root, 'repo')
  await git(root, ['init', '-q', '-b', 'main', repo])
  await git(repo, ['config', 'user.email', 't@t'])
  await git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'gone.txt'), 'bye\n')
  writeFileSync(join(repo, 'stable.txt'), 'never touched\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-qm', 'init'])

  assert.equal(await isRepo(repo), repo)
  assert.equal(await defaultBranch(repo), 'main')

  const wt = join(root, 'wt')
  await addWorktree(repo, wt, 'aig/test', 'main')

  writeFileSync(join(wt, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(wt, 'new.txt'), 'fresh\n')
  writeFileSync(join(wt, 'café x.txt'), 'accent\n')
  unlinkSync(join(wt, 'gone.txt')) // deleted, uncommitted, at checkpoint time
  await git(wt, ['add', 'new.txt']) // staged at checkpoint time
  assert.equal(await busy(wt), null)
  const cp = await snapshot(wt)
  const stableMtime = statSync(join(wt, 'stable.txt')).mtimeMs

  const d = await diff(wt, 'main')
  assert.match(d, /\+two/)
  assert.match(d, /\+fresh/)
  assert.match(d, /b\/café x\.txt/)

  // Agent keeps working: edits, commits, adds files; ignored files must survive a restore.
  writeFileSync(join(wt, 'a.txt'), 'changed\n')
  writeFileSync(join(wt, 'later.txt'), 'x\n')
  writeFileSync(join(wt, 'ignored'), 'keep me\n')
  await git(wt, ['add', '-A'])
  await git(wt, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'more'])
  writeFileSync(join(wt, 'untracked-later.txt'), 'y\n')

  mkdirSync(join(wt, 'sub'))
  await assert.rejects(restore(join(wt, 'sub'), cp), /not the root/)
  rmSync(join(wt, 'sub'), { recursive: true })

  await restore(wt, cp)
  assert.equal(statSync(join(wt, 'stable.txt')).mtimeMs, stableMtime, 'unchanged files keep their mtime')
  assert.equal((await git(wt, ['diff', '--cached', '--name-only'])).trim(), 'new.txt', 'staged state restored')
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'one\ntwo\n')
  assert.equal(readFileSync(join(wt, 'new.txt'), 'utf8'), 'fresh\n')
  assert.ok(!existsSync(join(wt, 'later.txt')))
  assert.ok(!existsSync(join(wt, 'untracked-later.txt')))
  assert.ok(existsSync(join(wt, 'ignored')))
  assert.ok(!existsSync(join(wt, 'gone.txt')), 'deletion at checkpoint must survive restore')
  assert.equal((await git(wt, ['rev-parse', 'HEAD'])).trim(), cp.head)
  const mergeHead = resolve(wt, (await git(wt, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim())
  writeFileSync(mergeHead, cp.head + '\n')
  assert.equal(await busy(wt), 'MERGE_HEAD')
  unlinkSync(mergeHead)
  // Main repo untouched.
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\n')

  await removeWorktree(repo, wt)
  assert.ok(!existsSync(wt))
})

test('untrackedMatching, pin/dropRefs, branches, defaultBranch via origin, removeWorktree idempotent', async () => {
  const { untrackedMatching, pin, dropRefs, branches } = await import('../lib/git.js')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cgtest2-')))
  const repo = join(root, 'repo')
  await git(root, ['init', '-q', '-b', 'trunk', repo])
  await git(repo, ['config', 'user.email', 't@t']); await git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, '.gitignore'), '.env*\nsecrets/\nnode_modules/\n')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init'])
  writeFileSync(join(repo, '.env'), 'X=1\n')
  writeFileSync(join(repo, '.env.local'), 'Y=1\n')
  mkdirSync(join(repo, 'app')); writeFileSync(join(repo, 'app/.env'), 'Z=1\n')
  mkdirSync(join(repo, 'secrets')); writeFileSync(join(repo, 'secrets/key.pem'), 'k\n')
  mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules/big.js'), '1\n')
  writeFileSync(join(repo, 'notes.txt'), 'untracked but not matching\n')

  assert.deepEqual((await untrackedMatching(repo, { patterns: ['.env*'] })).sort(), ['.env', '.env.local', 'app/.env'])
  assert.deepEqual(await untrackedMatching(repo, { patterns: ['secrets/'] }), ['secrets/key.pem'])
  writeFileSync(join(root, 'include'), '.env\nsecrets/\n')
  assert.deepEqual((await untrackedMatching(repo, { from: join(root, 'include') })).sort(), ['.env', 'app/.env', 'secrets/key.pem'])

  assert.deepEqual(await branches(repo), ['trunk'])
  assert.equal(await defaultBranch(repo), 'trunk', 'no origin: current branch')
  const bare = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', '-b', 'trunk', bare])
  await git(repo, ['remote', 'add', 'origin', bare]); await git(repo, ['push', '-q', 'origin', 'trunk'])
  await git(repo, ['remote', 'set-head', 'origin', 'trunk'])
  await git(repo, ['checkout', '-qb', 'feature'])
  assert.equal(await defaultBranch(repo), 'trunk', 'origin/HEAD wins over the checked-out branch')

  const cp = await snapshot(repo)
  await pin(repo, 'refs/aiguillage/ws1/1', cp)
  await pin(repo, 'refs/aiguillage/ws1/2', cp)
  await pin(repo, 'refs/aiguillage/ws2/1', cp)
  assert.equal((await git(repo, ['rev-parse', 'refs/aiguillage/ws1/1^{tree}'])).trim(), cp.tree)
  await dropRefs(repo, 'refs/aiguillage/ws1/')
  assert.equal((await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/aiguillage'])).trim(), 'refs/aiguillage/ws2/1')

  await removeWorktree(repo, join(root, 'never-existed')) // no throw
})

test('diff ignores ignored files and survives an unborn branch error cleanly', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cgtest3-')))
  const repo = join(root, 'repo')
  await git(root, ['init', '-q', '-b', 'main', repo])
  await git(repo, ['config', 'user.email', 't@t']); await git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init'])
  mkdirSync(join(repo, 'dist')); writeFileSync(join(repo, 'dist/out.js'), 'x\n')
  writeFileSync(join(repo, 'src.js'), 'y\n')
  const d = await diff(repo, 'main')
  assert.match(d, /src\.js/)
  assert.doesNotMatch(d, /dist\/out\.js/)

  const empty = join(root, 'empty')
  await git(root, ['init', '-q', '-b', 'main', empty])
  await assert.rejects(snapshot(empty)) // no HEAD yet: callers skip the checkpoint
})
