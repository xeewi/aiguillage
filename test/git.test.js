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

test('findLogo: logo before icon/favicon, shallowest, vector first; skips ignored, node_modules, tests', async () => {
  const { findLogo } = await import('../lib/git.js')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cgtest-logo-')))
  const repo = join(root, 'repo')
  await git(root, ['init', '-q', '-b', 'main', repo])
  const put = f => { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), 'x') }
  assert.equal(await findLogo(repo), null, 'nothing yet')
  put('public/favicon.ico'); put('src/icons/arrow.svg'); put('iconify.txt')
  assert.equal(await findLogo(repo), 'public/favicon.ico')
  put('build/icon.png'); put('build/icon.svg')
  assert.equal(await findLogo(repo), 'build/icon.svg', 'icon beats favicon, svg beats png')
  put('src/assets/brand/Logo-dark.png'); put('assets/logo.png'); put('test/logo.svg'); put('node_modules/x/logo.svg')
  writeFileSync(join(repo, '.gitignore'), 'dist/\n'); put('dist/logo.svg')
  assert.equal(await findLogo(repo), 'assets/logo.png', 'logo beats icon, shallowest wins, ignored/test paths skipped')
  rmSync(root, { recursive: true, force: true })
})

test('snapshot never takes the real index lock: a held index.lock changes nothing', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cgtest-')))
  const repo = join(root, 'repo')
  await git(root, ['init', '-q', '-b', 'main', repo])
  await git(repo, ['config', 'user.email', 't@t']); await git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'a.txt'), 'a'); await git(repo, ['add', '-A']); await git(repo, ['commit', '-qm', 'a'])
  const wt = join(root, 'wt')
  await addWorktree(repo, wt, 'feat', 'main')
  writeFileSync(join(wt, 'staged.txt'), 's'); await git(wt, ['add', 'staged.txt'])
  writeFileSync(join(wt, 'loose.txt'), 'l')
  const before = await snapshot(wt)
  const lock = resolve(wt, (await git(wt, ['rev-parse', '--git-path', 'index.lock'])).trim())
  writeFileSync(lock, 'held')
  const cp = await snapshot(wt)
  assert.deepEqual(cp, before)
  assert.equal(readFileSync(lock, 'utf8'), 'held')
  assert.equal((await git(wt, ['ls-tree', '-r', '--name-only', cp.index])).trim(), 'a.txt\nstaged.txt')
  assert.equal((await git(wt, ['ls-tree', '-r', '--name-only', cp.tree])).trim(), 'a.txt\nloose.txt\nstaged.txt')
})

test('snapshot of a conflicted index: index null, a tree of the working copy; restore puts that copy back', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cgtest-')))
  const repo = join(root, 'repo')
  await git(root, ['init', '-q', '-b', 'main', repo])
  await git(repo, ['config', 'user.email', 't@t']); await git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'f.txt'), 'base\n'); await git(repo, ['add', '-A']); await git(repo, ['commit', '-qm', 'base'])
  await git(repo, ['checkout', '-qb', 'other']); writeFileSync(join(repo, 'f.txt'), 'other\n'); await git(repo, ['commit', '-qam', 'other'])
  await git(repo, ['checkout', '-q', 'main']); writeFileSync(join(repo, 'f.txt'), 'main\n'); await git(repo, ['commit', '-qam', 'main'])
  await git(repo, ['merge', 'other']).catch(() => {}) // conflict
  assert.equal(await busy(repo), 'MERGE_HEAD')
  const conflicted = readFileSync(join(repo, 'f.txt'), 'utf8')
  writeFileSync(join(repo, 'loose.txt'), 'l')
  const cp = await snapshot(repo)
  assert.equal(cp.index, null)
  assert.match(cp.tree, /^[0-9a-f]{40}$/)
  writeFileSync(join(repo, 'f.txt'), 'later\n'); rmSync(join(repo, 'loose.txt')); writeFileSync(join(repo, 'extra.txt'), 'x')
  await restore(repo, cp)
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), conflicted)
  assert.equal(readFileSync(join(repo, 'loose.txt'), 'utf8'), 'l')
  assert.equal(existsSync(join(repo, 'extra.txt')), false)
  assert.equal(await busy(repo), null, 'the merge state is cleared, the index is HEAD again')
  rmSync(root, { recursive: true, force: true })
})

test('git() with a timeout kills a call that hangs and rejects at once', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cgtest-')))
  await git(dir, ['init', '-q'])
  const t0 = Date.now()
  // An alias that sleeps stands for a hung git; its output goes nowhere, so no pipe outlives the kill.
  await assert.rejects(git(dir, ['-c', 'alias.slow=!sleep 5 >/dev/null 2>&1 </dev/null', 'slow'], undefined, 200))
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
  rmSync(dir, { recursive: true, force: true })
})
