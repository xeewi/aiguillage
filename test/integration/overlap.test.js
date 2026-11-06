// Two workspaces of a repo changing the same files are reported as soon as it happens; a merge tells the others.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, setup, waitFor, sleep, git } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const overlapReports = () => srv.log('aiguilleur').then(l => l.filter(e => e.type === 'cg_report' && e.overlap))
const second = repo => srv.api('POST', '/workspaces', { repoId: repo.id })
const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }

test('two workspaces changing the same file: one report naming both, once', async () => {
  const { repo, w } = await setup(srv)
  const w2 = await second(repo)
  await srv.turn(w.id, 'write shared.txt one')
  await sleep(500)
  assert.equal((await overlapReports()).filter(e => e.overlap.includes('shared.txt')).length, 0)
  await srv.turn(w2.id, 'write shared.txt two')
  const rep = await waitFor(async () => (await overlapReports()).find(e => e.overlap.includes('shared.txt')), { what: 'overlap report' })
  assert.deepEqual(rep.overlap, ['shared.txt'])
  assert.equal(rep.status, 'decision')
  assert.match(rep.label, /↔/)
  await srv.turn(w2.id, 'just talk')
  await sleep(800)
  assert.equal((await overlapReports()).filter(e => e.overlap.includes('shared.txt')).length, 1)
})

test('after a merge, the other workspace hears about it with its next message', async () => {
  const { repoPath, repo, w } = await setup(srv)
  const w2 = await second(repo)
  await srv.turn(w.id, 'write merged.txt a')
  await srv.turn(w2.id, 'write merged.txt b')
  commit(w.path, 'a')
  await srv.api('POST', `/workspaces/${w.id}/merge`)
  assert.ok(git(repoPath, 'log', '-1', '--format=%s').includes('Merge'))
  assert.deepEqual((await srv.ws(w2.id)).notices?.length, 1)
  // A slash command keeps the notice for the next plain message.
  await srv.turn(w2.id, '/model sonnet')
  assert.deepEqual((await srv.ws(w2.id)).notices?.length, 1)
  assert.equal((await srv.log(w2.id)).filter(e => e.type === 'cg_user').at(-1).text, '/model sonnet')
  assert.match(await srv.turn(w2.id, 'memory'), /was just merged into main.*merged\.txt.*Rebase on main/s)
  assert.deepEqual((await srv.ws(w2.id)).notices, [])
})

test('free sessions and other repos are never compared', async () => {
  const { w } = await setup(srv)
  const other = await setup(srv)
  const free = await srv.api('POST', '/sessions', {})
  const mate = await second(w.repoId ? { id: w.repoId } : null)
  const before = (await overlapReports()).length
  await srv.turn(w.id, 'write same.txt 1')
  await srv.turn(other.w.id, 'write same.txt 2')
  await srv.turn(free.id, 'write same.txt 3')
  await srv.turn(mate.id, 'write same.txt 4') // positive control: this pair does report, and only it
  await waitFor(async () => (await overlapReports()).length > before, { what: 'the control pair' })
  await sleep(1000)
  assert.equal((await overlapReports()).length, before + 1)
})

test('a brief whose scope another workspace already touches carries the warning in its confirmation', async () => {
  const { repo, w } = await setup(srv)
  const w2 = await second(repo)
  await srv.turn(w.id, 'write src/auth.js x')
  const r = await srv.asAiguilleur('POST', `/workspaces/${w2.id}/brief`, { goal: 'Fix login', scope: ['src'], done: ['tests pass'] })
  const ask = (await srv.state()).aiguilleur.pending.find(x => x.id === r.pending)
  assert.match(ask.input.command, /overlaps .*src\/auth\.js/)
})
