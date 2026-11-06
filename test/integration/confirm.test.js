// The aiguilleur's irreversible actions (create, commit, merge, PR, archive, delete) wait for the user's click;
// the outcome comes back as a report in its conversation. The page acts at once, as before.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, git } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const commitIn = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }
const waiting = async () => (await srv.state()).aiguilleur.pending
const reportOn = (id, n = 0) => waitFor(async () => (await srv.log('aiguilleur')).filter(e => e.type === 'cg_report' && e.ws === id)[n], { what: `report on ${id}` })
const answer = (id, allow) => srv.api('POST', '/workspaces/aiguilleur/permission', { id, allow })

test('a merge asked by the aiguilleur waits; Allow merges, and the outcome is a ✅ report', async () => {
  const { repoPath, w } = await setup(srv)
  writeFileSync(join(w.path, 'feat.txt'), 'feat\n'); commitIn(w.path, 'feat')
  const head = git(repoPath, 'rev-parse', 'main')
  const r = await srv.asAiguilleur('POST', `/workspaces/${w.id}/merge`)
  assert.deepEqual([typeof r.pending, r.message], ['string', 'Waiting for the user to confirm.'])
  assert.equal(git(repoPath, 'rev-parse', 'main'), head, 'nothing merged yet')
  const p = (await waiting()).find(x => x.id === r.pending)
  assert.deepEqual([p.confirm, p.tool, p.input.command], [true, 'Aiguillage', 'Merge aig/' + w.name + ' into main'])
  await answer(r.pending, true)
  const rep = await reportOn(w.id)
  assert.equal(rep.ok, true)
  assert.match(rep.text, /Merged into main/)
  assert.ok(existsSync(join(repoPath, 'feat.txt')), 'main has the commit')
  assert.ok(!(await waiting()).some(x => x.id === r.pending), 'the request is gone')
})

test('Deny: nothing merged, a ❌ report says it was declined', async () => {
  const { repoPath, w } = await setup(srv)
  writeFileSync(join(w.path, 'no.txt'), 'no\n'); commitIn(w.path, 'no')
  const head = git(repoPath, 'rev-parse', 'main')
  const { pending } = await srv.asAiguilleur('POST', `/workspaces/${w.id}/merge`)
  await answer(pending, false)
  const rep = await reportOn(w.id)
  assert.equal(rep.ok, false)
  assert.match(rep.text, /declined/i)
  assert.equal(git(repoPath, 'rev-parse', 'main'), head)
})

test('the page still merges at once, as before', async () => {
  const { repoPath, w } = await setup(srv)
  writeFileSync(join(w.path, 'now.txt'), 'now\n'); commitIn(w.path, 'now')
  const r = await srv.api('POST', `/workspaces/${w.id}/merge`)
  assert.equal(r.pending, undefined)
  assert.match(r.message, /merge commit/)
  assert.ok(existsSync(join(repoPath, 'now.txt')))
})

test('a new workspace asked by the aiguilleur is created only after Allow', async () => {
  const { repo } = await setup(srv)
  const { pending } = await srv.asAiguilleur('POST', '/workspaces', { repoId: repo.id, name: 'later' })
  assert.equal((await waiting()).find(x => x.id === pending).input.command, `New workspace in ${repo.name}: later`)
  const mine = async () => (await srv.state()).workspaces.find(x => x.repoId === repo.id && x.name === 'later')
  assert.equal(await mine(), undefined)
  await answer(pending, true)
  const w = await waitFor(mine, { what: 'the new workspace' })
  const rep = await reportOn(w.id)
  assert.equal(rep.ok, true)
  await assert.rejects(srv.asAiguilleur('POST', '/workspaces', { repoId: 'nope' }), /Unknown repo/, 'an unknown repo is refused at once')
})

test('commit, PR, archive and delete wait too; the aiguilleur cannot confirm its own request', async () => {
  const { w } = await setup(srv)
  writeFileSync(join(w.path, 'c.txt'), 'c\n')
  const asked = []
  for (const [method, path, body] of [['POST', 'commit', { message: 'm' }], ['POST', 'pr'], ['POST', 'archive'], ['DELETE', '']])
    asked.push((await srv.asAiguilleur(method, `/workspaces/${w.id}${path && '/' + path}`, body)).pending)
  assert.ok(asked.every(Boolean))
  assert.equal(git(w.path, 'status', '--porcelain'), '?? c.txt', 'nothing committed')
  const now = await srv.ws(w.id)
  assert.ok(now && !now.archived, 'neither archived nor deleted')
  await assert.rejects(srv.asAiguilleur('POST', '/workspaces/aiguilleur/permission', { id: asked[0], allow: true }), e => e.status === 400)
  await srv.asAiguilleur('POST', `/workspaces/${w.id}/permission`, { id: asked[0], allow: true }) // not its workspace's request: no-op
  assert.ok((await waiting()).some(x => x.id === asked[0]), 'still waiting for the user')
  // The aiguilleur going auto never approves them either.
  await srv.asAiguilleur('PATCH', '/workspaces/aiguilleur', { permissionMode: 'default' })
  await srv.asAiguilleur('PATCH', '/workspaces/aiguilleur', { permissionMode: 'auto' })
  assert.equal(git(w.path, 'status', '--porcelain'), '?? c.txt')
  for (const id of asked) await answer(id, false)
  const left = await waiting()
  assert.ok(!asked.some(id => left.some(x => x.id === id)))
})
