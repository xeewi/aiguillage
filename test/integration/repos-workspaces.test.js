import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { startServer, setup, makeRepo, waitFor, git, tmp } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const runLog = id => join(srv.home, 'logs', id + '.run.log')
const readRunLog = id => existsSync(runLog(id)) ? readFileSync(runLog(id), 'utf8') : ''
const waitRunLog = (id, re) => waitFor(() => re.test(readRunLog(id)), { what: `run log ${re}` })
const addRepo = path => srv.api('POST', '/repos', { path })
const newWs = (repoId, extra = {}) => srv.api('POST', '/workspaces', { repoId, ...extra })

test('repos: ~ expansion, subdirectory → toplevel, non-repo 400, duplicate, base branch', async () => {
  const dir = join(srv.home, 'code', 'tilde')
  mkdirSync(dirname(dir), { recursive: true })
  git(dirname(dir), 'init', '-q', '-b', 'trunk', dir)
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub/f.txt'), 'x'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'i')

  const r = await addRepo('~/code/tilde')
  assert.equal(r.path, dir)
  assert.equal(r.name, 'tilde')
  assert.equal(r.base, 'trunk')
  assert.equal((await addRepo(join(dir, 'sub'))).id, r.id, 'subdirectory resolves to the same repo')
  assert.equal((await addRepo(dir)).id, r.id, 'duplicate returns the same repo')
  assert.equal((await srv.state()).repos.filter(x => x.path === dir).length, 1)

  await assert.rejects(addRepo(tmp('notrepo-')), e => e.status === 400 && /not a git repo/.test(e.message))
})

test('repos: /suggest lists git repos under HOME/code and skips added ones', async () => {
  const a = join(srv.home, 'code', 'sugg-a'), b = join(srv.home, 'code', 'sugg-b')
  for (const d of [a, b]) { git(srv.home, 'init', '-q', d); git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i') }
  mkdirSync(join(srv.home, 'code', 'plain-dir'), { recursive: true })
  let s = await srv.api('GET', '/suggest')
  assert.ok(s.includes(a) && s.includes(b))
  assert.ok(!s.includes(join(srv.home, 'code', 'plain-dir')))
  await addRepo(a)
  s = await srv.api('GET', '/suggest')
  assert.ok(!s.includes(a) && s.includes(b))
})

test('repos: PATCH base, DELETE refused with active workspaces then allowed', async () => {
  const { repo, repoPath, w } = await setup(srv)
  git(repoPath, 'branch', 'develop')
  assert.deepEqual((await srv.api('GET', `/repos/${repo.id}/branches`)).sort(), ['aig/' + w.name, 'develop', 'main'].sort())
  assert.equal((await srv.api('PATCH', `/repos/${repo.id}`, { base: 'develop' })).base, 'develop')
  const w2 = await newWs(repo.id)
  assert.equal(w2.base, 'develop')
  await assert.rejects(srv.api('DELETE', `/repos/${repo.id}`), /Archive/)
  await srv.api('POST', `/workspaces/${w.id}/archive`)
  await srv.api('POST', `/workspaces/${w2.id}/archive`)
  await srv.api('DELETE', `/repos/${repo.id}`)
  assert.ok(!(await srv.state()).repos.some(r => r.id === repo.id))
})

test('workspaces: city names, uniqueness, slugs, branch, location', async () => {
  const { repo, repoPath, w } = await setup(srv)
  assert.match(w.name, /^[a-z]+$/)
  assert.equal(w.branch, `aig/${w.name}`)
  assert.equal(w.path, join(srv.home, 'worktrees', `repo-${repo.id}`, w.name))
  assert.equal(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD'), w.branch)
  assert.equal(w.permissionMode, 'auto')

  const w2 = await newWs(repo.id)
  assert.notEqual(w2.name, w.name)

  const c = await newWs(repo.id, { name: 'My Task #1!' })
  assert.equal(c.name, 'my-task-1')
  assert.equal((await newWs(repo.id, { name: 'my task 1' })).name, 'my-task-1-v2')

  git(repoPath, 'branch', 'aig/taken')
  assert.equal((await newWs(repo.id, { name: 'taken' })).name, 'taken-v2', 'existing aig/ branches count as taken')
})

test('workspaces: accented names are slugified without breaking words', async () => {
  const { repo } = await setup(srv)
  assert.equal((await newWs(repo.id, { name: 'Ma Belle Tâche' })).name, 'ma-belle-tache')
})

test('repos: a freshly initialised repo without commits can be added', async () => {
  const d = join(tmp('empty-'), 'r')
  git(dirname(d), 'init', '-q', '-b', 'main', d)
  const repo = await addRepo(d)
  assert.equal(repo.base, 'main')
  await assert.rejects(newWs(repo.id), /no commit yet/)
})

test('workspaces: ports unique and spaced by 10, also across archive/unarchive', async () => {
  const { repo, w } = await setup(srv)
  const w2 = await newWs(repo.id)
  await srv.api('POST', `/workspaces/${w.id}/archive`)
  const w3 = await newWs(repo.id)
  await srv.api('POST', `/workspaces/${w.id}/unarchive`)
  const live = (await srv.state()).workspaces.filter(x => !x.archived)
  const ports = live.map(x => x.port)
  assert.equal(new Set(ports).size, ports.length)
  for (const p of [w.port, w2.port, w3.port]) assert.equal((p - 40000) % 10, 0)
  assert.notEqual(w3.port, w.port, 'archived workspace keeps its port reserved')
})

test('workspaces: start from origin/main when origin is ahead, no upstream tracking', async () => {
  const repoPath = makeRepo({ 'README.md': '# o\n' }, { origin: true })
  const bare = join(dirname(repoPath), 'origin.git')
  const clone = join(dirname(repoPath), 'clone')
  git(dirname(repoPath), 'clone', '-q', bare, clone)
  git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'remote only')
  git(clone, 'push', '-q', 'origin', 'main')
  const repo = await addRepo(repoPath)
  const w = await newWs(repo.id)
  assert.equal(w.baseRef, 'origin/main')
  assert.equal(git(w.path, 'log', '-1', '--format=%s'), 'remote only')
  assert.equal(git(repoPath, 'log', '-1', '--format=%s'), 'init', 'root checkout untouched')
  assert.throws(() => git(w.path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'no upstream tracking')
})

test('workspaces: no origin or unreachable origin falls back to local base', async () => {
  const { w } = await setup(srv)
  assert.equal(w.baseRef, 'main')
  const repoPath = makeRepo()
  git(repoPath, 'remote', 'add', 'origin', join(tmp('gone-'), 'nope.git'))
  const w2 = await newWs((await addRepo(repoPath)).id)
  assert.equal(w2.baseRef, 'main')
  assert.equal(git(w2.path, 'log', '-1', '--format=%s'), 'init')
})

test('workspaces: files to copy — .env* by default, nested too', async () => {
  const repoPath = makeRepo({ '.gitignore': '.env*\nsecret.key\n' })
  writeFileSync(join(repoPath, '.env'), 'A=1')
  writeFileSync(join(repoPath, '.env.local'), 'B=2')
  mkdirSync(join(repoPath, 'app')); writeFileSync(join(repoPath, 'app/.env'), 'C=3')
  writeFileSync(join(repoPath, 'secret.key'), 'k')
  const w = await newWs((await addRepo(repoPath)).id)
  assert.equal(readFileSync(join(w.path, '.env'), 'utf8'), 'A=1')
  assert.equal(readFileSync(join(w.path, '.env.local'), 'utf8'), 'B=2')
  assert.equal(readFileSync(join(w.path, 'app/.env'), 'utf8'), 'C=3')
  assert.ok(!existsSync(join(w.path, 'secret.key')))
})

test('workspaces: .worktreeinclude takes precedence over the default', async () => {
  const repoPath = makeRepo({ '.gitignore': '.env\nconfig/secret.key\n', '.worktreeinclude': 'config/secret.key\n' })
  writeFileSync(join(repoPath, '.env'), 'A=1')
  mkdirSync(join(repoPath, 'config')); writeFileSync(join(repoPath, 'config/secret.key'), 'k')
  const w = await newWs((await addRepo(repoPath)).id)
  assert.equal(readFileSync(join(w.path, 'config/secret.key'), 'utf8'), 'k')
  assert.ok(!existsSync(join(w.path, '.env')))
})

test('workspaces: file_include_globs from .aiguillage/settings.toml', async () => {
  const repoPath = makeRepo({ '.gitignore': '*.pem\n.env\n', '.aiguillage/settings.toml': 'file_include_globs = ["*.pem"]\n' })
  writeFileSync(join(repoPath, 'cert.pem'), 'pem')
  writeFileSync(join(repoPath, '.env'), 'A=1')
  const w = await newWs((await addRepo(repoPath)).id)
  assert.equal(readFileSync(join(w.path, 'cert.pem'), 'utf8'), 'pem')
  assert.ok(!existsSync(join(w.path, '.env')))
})

test('workspaces: setup script from TOML runs, output lands in the run log', async () => {
  const { w } = await setup(srv, { '.aiguillage/settings.toml': '[scripts]\nsetup = "echo toml-setup $AIGUILLAGE_WORKSPACE_NAME > setup.out; echo toml-setup-done"\n' })
  await waitRunLog(w.id, /toml-setup-done[\s\S]*\[exit 0\]/)
  assert.equal(readFileSync(join(w.path, 'setup.out'), 'utf8').trim(), `toml-setup ${w.name}`)
})

test('workspaces: setup script from aiguillage.json', async () => {
  const a = await setup(srv, { 'aiguillage.json': '{"setup":"echo from-aiguillage-json"}' })
  await waitRunLog(a.w.id, /from-aiguillage-json/)
})

test('workspaces: archive keeps branch, runs archive script, stops agent, pins and restores wip', async () => {
  const marker = join(tmp('archmark-'), 'archived.txt')
  const { repoPath, w } = await setup(srv, { 'aiguillage.json': JSON.stringify({ archive: `echo bye > ${marker}` }) })
  await srv.turn(w.id, 'hi')
  writeFileSync(join(w.path, 'wip.txt'), 'draft')
  writeFileSync(join(w.path, 'README.md'), '# changed\n')

  await srv.api('POST', `/workspaces/${w.id}/archive`)
  const archived = await srv.ws(w.id)
  assert.ok(archived.archived)
  assert.equal(archived.busy, false)
  assert.ok(!existsSync(w.path), 'worktree removed')
  assert.equal(git(repoPath, 'branch', '--list', w.branch).replace('*', '').trim(), w.branch, 'branch kept')
  assert.equal(readFileSync(marker, 'utf8').trim(), 'bye', 'archive script ran')
  assert.ok(git(repoPath, 'for-each-ref', `refs/aiguillage/${w.id}/archive`), 'wip pinned')

  await srv.api('POST', `/workspaces/${w.id}/unarchive`)
  assert.equal(readFileSync(join(w.path, 'wip.txt'), 'utf8'), 'draft')
  assert.equal(readFileSync(join(w.path, 'README.md'), 'utf8'), '# changed\n')
  assert.ok(!(await srv.ws(w.id)).archived)
  assert.equal(await srv.turn(w.id, 'memory'), 'memory: hi | memory', 'conversation resumes after unarchive')
})

test('workspaces: DELETE removes worktree, branch and checkpoint refs', async () => {
  const { repoPath, w } = await setup(srv)
  await srv.turn(w.id, 'hi')
  assert.ok(git(repoPath, 'for-each-ref', `refs/aiguillage/${w.id}/`))
  await srv.api('DELETE', `/workspaces/${w.id}`)
  assert.ok(!(await srv.state()).workspaces.some(x => x.id === w.id))
  assert.ok(!existsSync(w.path))
  assert.equal(git(repoPath, 'branch', '--list', w.branch), '')
  assert.equal(git(repoPath, 'for-each-ref', `refs/aiguillage/${w.id}/`), '')
})

test('defaults: model and effort apply to new workspaces only', async () => {
  const { repo, w } = await setup(srv)
  const d = await srv.api('PATCH', '/defaults', { model: 'opus', effort: 'high', permissionMode: 'plan' })
  assert.deepEqual(d, { model: 'opus', effort: 'high', permissionMode: 'plan', autoUpdate: true, maxAgents: 5 })
  assert.equal((await srv.api('PATCH', '/defaults', { ...d, autoUpdate: false })).autoUpdate, false)
  // maxAgents: an integer from 1 to 20, unchanged when the body leaves it out or sends no number.
  assert.equal((await srv.api('PATCH', '/defaults', { ...d, maxAgents: 50 })).maxAgents, 20)
  assert.equal((await srv.api('PATCH', '/defaults', { ...d, maxAgents: 0 })).maxAgents, 1)
  assert.equal((await srv.api('PATCH', '/defaults', { ...d, maxAgents: 7 })).maxAgents, 7)
  for (const maxAgents of ['x', '', null]) assert.equal((await srv.api('PATCH', '/defaults', { ...d, maxAgents })).maxAgents, 7, JSON.stringify(maxAgents))
  assert.equal((await srv.api('PATCH', '/defaults', { model: 'opus', effort: 'high', permissionMode: 'plan' })).maxAgents, 7)
  await srv.api('PATCH', '/defaults', d)
  assert.deepEqual((await srv.state()).defaults, d)
  const w2 = await newWs(repo.id)
  assert.equal(w2.model, 'opus'); assert.equal(w2.effort, 'high'); assert.equal(w2.permissionMode, 'plan')
  assert.notEqual((await srv.state()).workspaces.find(x => x.id === w.id).model, 'opus')
  await srv.api('PATCH', '/defaults', { model: '', effort: '', permissionMode: 'bypassPermissions' })
  const w3 = await newWs(repo.id)
  assert.equal(w3.model, ''); assert.equal(w3.permissionMode, 'auto')
})

test('sessions: tied to no project, in a git folder of their own; chat, archive, delete', async () => {
  const s = await srv.api('POST', '/sessions')
  assert.ok(s.free && !s.repoId && !s.branch)
  assert.equal(s.path, join(srv.home, 'sessions', s.id))
  assert.equal(git(s.path, 'rev-parse', '--show-toplevel'), s.path, 'its own repo: git never walks up to a tracked $HOME')
  await srv.turn(s.id, 'hello')
  const run = srv.fakeArgv().findLast(a => a.cwd === s.path)
  assert.match(run.argv[run.argv.indexOf('--append-system-prompt') + 1], /standalone session, tied to no project/)
  assert.ok((await srv.log(s.id)).find(e => e.type === 'cg_user').cp, 'checkpoints work: revert is offered')
  await srv.api('POST', `/workspaces/${s.id}/archive`)
  assert.ok((await srv.ws(s.id)).archived && existsSync(s.path), 'archived, folder kept')
  await srv.api('POST', `/workspaces/${s.id}/unarchive`)
  assert.ok(!(await srv.ws(s.id)).archived)
  await srv.api('DELETE', `/workspaces/${s.id}`)
  assert.ok(!(await srv.ws(s.id)) && !existsSync(s.path))
})
