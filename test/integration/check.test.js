// The per-repo check script: runs after a turn that changed something, its result rides the report, and a red or
// out-of-date one stops the merge unless forced.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
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
  const asked = await srv.asAiguilleur('POST', `/workspaces/${w.id}/merge`).catch(e => e)
  assert.equal(asked.key, 'errors.checkNotGreen', 'refused before asking the user')
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
  const s = await srv.api('POST', '/sessions')
  await srv.turn(s.id, 'write ok.txt yes')
  assert.equal('check' in await reportOn(s.id), false)
})
