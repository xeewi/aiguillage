// The per-repo check script: runs after a turn that changed something, its result rides the report, and a red or
// out-of-date one stops the merge unless forced.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, git } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const CHECK = { '.aiguillage/settings.toml': '[scripts]\ncheck = "test -f ok.txt"\n' }
const reports = id => srv.log('aiguilleur').then(l => l.filter(e => e.type === 'cg_report' && e.ws === id))
const reportOn = (id, n = 0) => waitFor(async () => (await reports(id))[n], { what: `report ${n} on ${id}` })
const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }

test('a turn that writes ok.txt reports 🧪 passed', async () => {
  const { w } = await setup(srv, CHECK)
  await srv.turn(w.id, 'write ok.txt yes')
  const rep = await reportOn(w.id)
  assert.deepEqual([rep.check.ok, rep.check.code], [true, 0])
  const saved = await srv.ws(w.id)
  assert.equal(saved.check.ok, true)
  assert.equal(saved.checking, false)
})

test('a red check blocks the merge until force: true; Run check re-runs it', async () => {
  const { repoPath, w } = await setup(srv, CHECK)
  await srv.turn(w.id, 'write other.txt x')
  const rep = await reportOn(w.id)
  assert.equal(rep.check.ok, false)
  commit(w.path, 'work')
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/merge`), e => e.key === 'errors.checkNotGreen' && e.vars.context === 'failed')
  const r = await srv.api('POST', `/workspaces/${w.id}/merge`, { force: true })
  assert.match(r.message, /Merged/)
  assert.ok(git(repoPath, 'log', '-1', '--format=%s').includes('Merge'))
})

test('a green check, then a change: the merge is refused as out of date until Run check', async () => {
  const { w } = await setup(srv, CHECK)
  await srv.turn(w.id, 'write ok.txt yes')
  await reportOn(w.id)
  commit(w.path, 'ok')
  writeFileSync(join(w.path, 'later.txt'), 'l'); commit(w.path, 'later') // by hand: no turn, no check
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/merge`), e => e.vars.context === 'stale')
  assert.equal((await srv.api('POST', `/workspaces/${w.id}/check`)).ok, true)
  assert.match((await srv.api('POST', `/workspaces/${w.id}/merge`)).message, /Merged/)
})

test('the check does not run again when nothing changed since the last one', async () => {
  const n = (await srv.api('GET', '/metrics?days=1')).checks.n
  const { w } = await setup(srv, CHECK)
  await srv.turn(w.id, 'write ok.txt yes')
  await reportOn(w.id)
  await srv.turn(w.id, 'just talk')
  const second = await reportOn(w.id, 1)
  assert.equal('check' in second, false)
  assert.equal((await srv.api('GET', '/metrics?days=1')).checks.n, n + 1)
})

test('without a check script, or in a free session, reports and merge are unchanged', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'write a.txt a')
  assert.equal('check' in await reportOn(w.id), false)
  assert.equal((await srv.ws(w.id)).check, undefined)
  commit(w.path, 'a')
  assert.match((await srv.api('POST', `/workspaces/${w.id}/merge`)).message, /Merged/)
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/check`), e => e.key === 'errors.noCheck')
  // A check in the user-level settings would apply to a free session if the guard were gone.
  mkdirSync(join(srv.home, '.aiguillage'), { recursive: true })
  writeFileSync(join(srv.home, '.aiguillage/settings.toml'), '[scripts]\ncheck = "true"\n')
  const n = (await srv.api('GET', '/metrics?days=1')).checks.n
  const s = await srv.api('POST', '/sessions')
  await srv.turn(s.id, 'write ok.txt yes')
  assert.equal('check' in await reportOn(s.id), false)
  assert.equal((await srv.api('GET', '/metrics?days=1')).checks.n, n)
  await assert.rejects(srv.api('POST', `/workspaces/${s.id}/check`), e => e.key === 'errors.noCheck')
  rmSync(join(srv.home, '.aiguillage/settings.toml'))
})

test('two checks asked at once run once; both get the same result', async () => {
  const n = (await srv.api('GET', '/metrics?days=1')).checks.n
  const { w } = await setup(srv, { '.aiguillage/settings.toml': '[scripts]\ncheck = "sleep 1; test -f ok.txt"\n' })
  const [a, b] = await Promise.all([1, 2].map(() => srv.api('POST', `/workspaces/${w.id}/check`)))
  assert.deepEqual(a, b)
  assert.equal((await srv.api('GET', '/metrics?days=1')).checks.n, n + 1)
})

test("a merge asked by the aiguilleur on a red check waits with a ❌ label; Allow merges it, the aiguilleur never forces", async () => {
  const { repoPath, w } = await setup(srv, CHECK)
  await srv.turn(w.id, 'write other.txt x')
  await reportOn(w.id)
  commit(w.path, 'work')
  const r = await srv.asAiguilleur('POST', `/workspaces/${w.id}/merge`, { force: false })
  const p = (await srv.state()).aiguilleur.pending.find(x => x.id === r.pending)
  assert.match(p.input.command, /check ❌$/)
  await srv.api('POST', '/workspaces/aiguilleur/permission', { id: r.pending, allow: true })
  const rep = await waitFor(async () => (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_report' && e.ws === w.id && e.key === 'messages.merged'), { what: 'merged report' })
  assert.equal(rep.ok, true)
  assert.ok(git(repoPath, 'log', '-1', '--format=%s').includes('Merge'))
})

test('the diff says whether the saved check ran on these very files', async () => {
  const { w } = await setup(srv, CHECK)
  assert.equal((await srv.api('GET', `/workspaces/${w.id}/diff`)).checkFresh, false, 'never run')
  await srv.turn(w.id, 'write ok.txt yes')
  await reportOn(w.id)
  assert.equal((await srv.api('GET', `/workspaces/${w.id}/diff`)).checkFresh, true)
  writeFileSync(join(w.path, 'later.txt'), 'l')
  assert.equal((await srv.api('GET', `/workspaces/${w.id}/diff`)).checkFresh, false)
})

test("the check is the main checkout's: an agent rewriting its worktree's settings.toml doesn't change it", async () => {
  const { w } = await setup(srv, { '.aiguillage/settings.toml': '[scripts]\ncheck = "false"\n' })
  writeFileSync(join(w.path, '.aiguillage/settings.toml'), '[scripts]\ncheck = "true"\n') // what the agent could write
  await srv.turn(w.id, 'write a.txt a')
  const rep = await reportOn(w.id)
  assert.equal(rep.check.ok, false, 'the root\'s failing check ran')
})
