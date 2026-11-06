// Two workspaces of a repo changing the same files are reported as soon as it happens; a merge tells the others.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, sleep, git, tmp } from '../helpers.mjs'

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
  const { repo, w } = await setup(srv)
  const other = await setup(srv)
  const free = await srv.api('POST', '/sessions', {})
  const mate = await second(repo)
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
  await srv.turnScanned(w.id, 'write src/auth.js x') // the warning reads the scan's lists
  const r = await srv.asAiguilleur('POST', `/workspaces/${w2.id}/brief`, { goal: 'Fix login', scope: ['src'], done: ['tests pass'] })
  const ask = (await srv.state()).aiguilleur.pending.find(x => x.id === r.pending)
  assert.match(ask.input.command, /overlaps .*src\/auth\.js/)
})

// Snapshots taken so far, per folder; waits until no git work is still running (two equal reads).
const quiet = () => waitFor(async () => { const a = JSON.stringify(await srv.counters()); await sleep(300); return a === JSON.stringify(await srv.counters()) && JSON.parse(a) }, { what: 'no git work running' })

test("a turn's end scans its own repo only", async () => {
  const a = await setup(srv), b = await setup(srv)
  const before = await quiet()
  await srv.turn(a.w.id, 'write x.txt x')
  await waitFor(async () => (await srv.counters()).scans > before.scans, { what: 'the scan after the turn' })
  const after = await quiet()
  assert.ok(after.snapshots[a.w.path] > (before.snapshots[a.w.path] ?? 0), 'its own workspace is looked at')
  assert.equal(after.snapshots[b.w.path] ?? 0, before.snapshots[b.w.path] ?? 0, "another repo's workspace is not")
})

test("the brief's overlap warning reads the scan's lists: no snapshot while answering", async () => {
  const { repo, w } = await setup(srv)
  const w2 = await second(repo)
  await srv.turnScanned(w.id, 'write lib/a.js x')
  const before = await quiet()
  const r = await srv.asAiguilleur('POST', `/workspaces/${w2.id}/brief`, { goal: 'Fix it', scope: ['lib'], done: ['tests pass'] })
  assert.match((await srv.state()).aiguilleur.pending.find(x => x.id === r.pending).input.command, /overlaps .*lib\/a\.js/)
  assert.deepEqual((await srv.counters()).snapshots, before.snapshots)
})

test('a merge notice pushed while the message is being sent is never lost: sent with it, or kept for the next one', async () => {
  const { repoPath, repo, w } = await setup(srv)
  const w2 = await second(repo)
  writeFileSync(join(w.path, 'n.txt'), 'a'); commit(w.path, 'a')
  writeFileSync(join(w2.path, 'n.txt'), 'b')
  await srv.api('POST', `/workspaces/${w.id}/merge`)
  assert.equal((await srv.ws(w2.id)).notices.length, 1)
  // The send's checkpoint of w2 takes a second while the flag exists (a clean filter on slow.txt): the second merge,
  // with the same notice, lands inside the send.
  const flag = join(tmp(), 'flag')
  git(repoPath, 'config', 'filter.slow.clean', `if [ -f ${flag} ]; then sleep 1; fi; cat`)
  writeFileSync(join(repoPath, '.git/info/attributes'), 'slow.txt filter=slow\n')
  writeFileSync(join(w2.path, 'slow.txt'), 's')
  writeFileSync(join(w.path, 'n.txt'), 'a2'); commit(w.path, 'a2')
  writeFileSync(flag, '')
  const sent = srv.api('POST', `/workspaces/${w2.id}/send`, { text: 'memory' })
  await sleep(300)
  rmSync(flag)
  await srv.api('POST', `/workspaces/${w.id}/merge`)
  await sent
  await srv.idle(w2.id)
  const said = (await srv.log(w2.id)).findLast(e => e.type === 'assistant').message.content[0].text
  const told = said.split('was just merged into main').length - 1
  assert.equal(told + (await srv.ws(w2.id)).notices.length, 2)
})

test('overlaps already there at startup are reported without waiting for the 10-minute scan', async () => {
  const home = tmp('cghome-')
  const one = await startServer({ home })
  const { repo, w } = await setup(one)
  const w2 = await one.api('POST', '/workspaces', { repoId: repo.id })
  writeFileSync(join(w.path, 'both.txt'), '1'); writeFileSync(join(w2.path, 'both.txt'), '2') // by hand: no turn, no scan
  await one.stop()
  const two = await startServer({ home })
  try {
    const rep = await waitFor(async () => (await two.log('aiguilleur')).find(e => e.type === 'cg_report' && e.overlap), { what: 'overlap report', timeout: 5000 })
    assert.deepEqual(rep.overlap, ['both.txt'])
  } finally { await two.stop() }
})
