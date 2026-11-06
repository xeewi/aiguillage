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
  assert.deepEqual([rep.key, rep.vars, rep.text], ['messages.merged', { base: 'main' }, ''], 'kept as key + vars, translated when shown')
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
  assert.deepEqual([rep.key, rep.vars.action], ['confirm.denied', { key: 'confirm.merge', vars: { branch: 'aig/' + (await srv.ws(rep.ws)).name, base: 'main' } }])
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
  await assert.rejects(srv.asAiguilleur('POST', '/workspaces/aiguilleur/permission', { id: asked[0], allow: true }), e => e.status === 403)
  await assert.rejects(srv.asAiguilleur('POST', `/workspaces/${w.id}/permission`, { id: asked[0], allow: true }), e => e.status === 403)
  assert.ok((await waiting()).some(x => x.id === asked[0]), 'still waiting for the user')
  // Switching to auto (which approves what waits) is the user's too.
  await assert.rejects(srv.asAiguilleur('PATCH', '/workspaces/aiguilleur', { permissionMode: 'auto' }), e => e.status === 403)
  assert.equal(git(w.path, 'status', '--porcelain'), '?? c.txt')
  for (const id of asked) await answer(id, false)
  const left = await waiting()
  assert.ok(!asked.some(id => left.some(x => x.id === id)))
})

test("the aiguilleur's API is deny-by-default: what isn't on its list answers 403", async () => {
  const { repo, w } = await setup(srv)
  await srv.api('PATCH', `/workspaces/${w.id}`, { permissionMode: 'default' })
  // ponytail: no folder picker, setup step, update or « open »: if one slipped through, it would act on this Mac.
  const refused = [
    ['POST', `/workspaces/${w.id}/permission`, { id: 'x', allow: true }],
    ['POST', '/workspaces/aiguilleur/permission', { id: 'x', allow: true }],
    ['PATCH', `/workspaces/${w.id}`, { permissionMode: 'auto' }],
    ['PATCH', `/workspaces/${w.id}`, { title: 'sneaky', model: 'opus' }],
    ['PATCH', `/workspaces/${w.id}`, { effort: 'high' }],
    ['POST', `/workspaces/${w.id}/revert`, { msgId: 'x' }],
    ['POST', `/workspaces/${w.id}/run`, {}],
    ['POST', `/workspaces/${w.id}/run-stop`, {}],
    ['POST', `/workspaces/${w.id}/terminal-command`, { command: 'nope' }],
    ['POST', `/workspaces/${w.id}/unarchive`, {}],
    ['POST', '/workspaces/aiguilleur/brief', { goal: 'Brief myself' }],
    ['POST', '/telegram', { token: '' }],
    ['PATCH', '/telegram', { digest: 'off' }],
    ['PATCH', '/defaults', { maxAgents: 20 }],
    ['POST', '/repos', { path: '/nonexistent' }],
    ['PATCH', `/repos/${repo.id}`, { base: 'other' }],
    ['DELETE', `/repos/${repo.id}`],
    ['POST', '/sessions', {}],
    ['GET', '/suggest'],
    ['GET', `/repos/${repo.id}/branches`],
  ]
  for (const [method, path, body] of refused)
    await assert.rejects(srv.asAiguilleur(method, path, body), e => e.status === 403 && e.key === 'errors.notForAiguilleur', `${method} ${path} ${JSON.stringify(body)}`)
  const now = await srv.ws(w.id)
  assert.deepEqual([now.permissionMode, now.title ?? null, now.effort], ['default', null, ''], 'nothing changed')
  assert.equal((await srv.state()).defaults.maxAgents, 5)
  // Still open to it: reading, relaying, a rename, and its own conversation.
  assert.ok(Array.isArray((await srv.asAiguilleur('GET', '/state')).workspaces))
  for (const p of ['log', 'diff', 'scripts', 'commands']) await srv.asAiguilleur('GET', `/workspaces/${w.id}/${p}`)
  await srv.asAiguilleur('GET', '/workspaces/aiguilleur/log')
  await srv.asAiguilleur('GET', '/metrics')
  await srv.asAiguilleur('PATCH', `/workspaces/${w.id}`, { title: 'Renamed' })
  assert.equal((await srv.ws(w.id)).title, 'Renamed')
  await assert.rejects(srv.asAiguilleur('POST', `/workspaces/${w.id}/check`), e => e.key === 'errors.noCheck', 'reaches the route')
  await srv.asAiguilleur('POST', `/workspaces/${w.id}/stop-task`, { id: 'none' })
  await srv.asAiguilleur('POST', `/workspaces/${w.id}/interrupt`)
  await srv.asAiguilleur('POST', `/workspaces/${w.id}/send`, { text: 'relayed' })
  await waitFor(async () => (await srv.log(w.id)).some(e => e.type === 'result'), { what: 'the relayed turn' })
})

test('a brief from the aiguilleur waits for a click, then reaches the agent and is kept on the workspace', async () => {
  const { w } = await setup(srv)
  const r = await srv.asAiguilleur('POST', `/workspaces/${w.id}/brief`, { goal: 'Fix login', scope: ['src/auth.js'], done: ['tests pass'] })
  assert.equal(typeof r.pending, 'string')
  assert.match((await waiting()).find(x => x.id === r.pending).input.command, /Task brief\nGoal: Fix login/)
  assert.equal((await srv.ws(w.id)).task, undefined, 'nothing kept yet')
  await answer(r.pending, true)
  const task = await waitFor(async () => (await srv.ws(w.id)).task, { what: 'the kept brief' })
  assert.deepEqual([task.goal, task.scope, task.done], ['Fix login', ['src/auth.js'], ['tests pass']])
  const sent = await waitFor(async () => (await srv.log(w.id)).findLast(e => e.type === 'cg_user'), { what: 'the brief reaching the agent' })
  assert.match(sent.text, /^Task brief\nGoal: Fix login/)
  await assert.rejects(srv.asAiguilleur('POST', `/workspaces/${w.id}/brief`, { goal: '' }), /brief/i, 'a bad brief is refused at once')
})

test('a brief from the page is sent at once', async () => {
  const { w } = await setup(srv)
  const r = await srv.api('POST', `/workspaces/${w.id}/brief`, { goal: 'Add a button', escalate: 'a new dependency' })
  assert.equal(r.pending, undefined)
  assert.equal((await srv.ws(w.id)).task.escalate, 'a new dependency')
  const sent = await waitFor(async () => (await srv.log(w.id)).findLast(e => e.type === 'cg_user'), { what: 'the brief' })
  assert.match(sent.text, /^Task brief\nGoal: Add a button\nEscalate to the user before: a new dependency$/)
})

test('a workspace created with a brief: one confirmation for both', async () => {
  const { repo } = await setup(srv)
  const { pending } = await srv.asAiguilleur('POST', '/workspaces', { repoId: repo.id, name: 'briefed', brief: { goal: 'Do it' } })
  const cmd = (await waiting()).find(x => x.id === pending).input.command
  assert.match(cmd, /briefed/); assert.match(cmd, /Goal: Do it/)
  await answer(pending, true)
  const w = await waitFor(async () => (await srv.state()).workspaces.find(x => x.repoId === repo.id && x.name === 'briefed' && x.task), { what: 'the briefed workspace' })
  assert.equal(w.task.goal, 'Do it')
})
