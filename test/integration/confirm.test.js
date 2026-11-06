// The aiguilleur's irreversible actions (create, commit, merge, PR, archive, delete) wait for the user's click;
// the outcome comes back as a report in its conversation. The page acts at once, as before.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs'
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
    ['DELETE', `/workspaces/${w.id}/queued/x`],
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

test('the create confirmation names the workspace as it will be made: its free name, and a base other than the repo\'s', async () => {
  const { repo, repoPath, w } = await setup(srv)
  git(repoPath, 'branch', 'dev')
  const ask = async body => { const { pending } = await srv.asAiguilleur('POST', '/workspaces', { repoId: repo.id, ...body }); return [pending, (await waiting()).find(x => x.id === pending).input.command] }
  const [taken, l1] = await ask({ name: w.name })
  assert.equal(l1, `New workspace in ${repo.name}: ${w.name}-v2`, 'the name it will really get')
  const [none, l2] = await ask({})
  assert.equal(l2, `New workspace in ${repo.name}: lima`, 'the next free city, not « … »')
  const [same, l3] = await ask({ name: 'same', base: 'main' })
  assert.equal(l3, `New workspace in ${repo.name}: same`, "the repo's own base goes unsaid")
  const [dev, l4] = await ask({ name: 'feat', base: 'dev', brief: { goal: 'Go' } })
  assert.match(l4, new RegExp(`^New workspace in ${repo.name}: feat, from dev, with this brief:\n`))
  for (const p of [none, same]) await answer(p, false)
  for (const p of [taken, dev]) await answer(p, true)
  const made = await waitFor(async () => { const l = (await srv.state()).workspaces.filter(x => x.repoId === repo.id); return l.length === 3 && l }, { what: 'both created' })
  assert.deepEqual(made.map(x => [x.name, x.base]).sort(), [[w.name, 'main'], [w.name + '-v2', 'main'], ['feat', 'dev']].sort())
})

test('a brief that cannot be sent is not kept on the workspace', async () => {
  const { w } = await setup(srv)
  rmSync(w.path, { recursive: true, force: true })
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/brief`, { goal: 'Never sent' }), e => e.key === 'errors.worktreeMissing')
  assert.equal((await srv.ws(w.id)).task, undefined)
})

test('a workspace created with a brief that cannot be sent stays; its ❌ report says « created, brief not sent »', async () => {
  const { repo, repoPath } = await setup(srv)
  // The worktree vanishes right after its checkout: the creation goes through, the brief can't reach an agent.
  const hook = join(repoPath, '.git/hooks/post-checkout')
  writeFileSync(hook, '#!/bin/sh\ncase "$PWD" in */nobrief) rm -rf "$PWD";; esac\nexit 0\n'); chmodSync(hook, 0o755)
  const { pending } = await srv.asAiguilleur('POST', '/workspaces', { repoId: repo.id, name: 'nobrief', brief: { goal: 'Lost' } })
  await answer(pending, true)
  const w = await waitFor(async () => (await srv.state()).workspaces.find(x => x.repoId === repo.id && x.name === 'nobrief'), { what: 'the workspace' })
  const rep = await reportOn(w.id)
  assert.deepEqual([rep.ok, rep.key, rep.vars], [false, 'confirm.createdNoBrief', { name: 'nobrief', reason: { key: 'errors.worktreeMissing', vars: { path: w.path } } }])
  assert.equal(w.task, undefined)
})

test('a workspace deleted while its confirmation waits: Allow gives a ❌ report, nothing throws', async () => {
  const { w } = await setup(srv)
  const { pending } = await srv.asAiguilleur('POST', `/workspaces/${w.id}/commit`, { message: 'm' })
  await srv.api('DELETE', `/workspaces/${w.id}`)
  await answer(pending, true)
  const rep = await waitFor(async () => (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_report' && e.action && e.label?.key === 'confirm.commit' && e.label.vars.name === w.name), { what: 'the outcome' })
  assert.deepEqual([rep.ok, rep.key, rep.ws], [false, 'errors.notFound', 'aiguilleur'])
  assert.ok((await srv.state()).workspaces, 'still up')
})

// state.json, edited while the server is stopped.
const edit = (home, fn) => { const f = join(home, 'state.json'), st = JSON.parse(readFileSync(f, 'utf8')); fn(st); writeFileSync(f, JSON.stringify(st)) }

test('a confirmation survives a restart: asked again with its label, and Allow then runs it', async () => {
  let s = await startServer()
  try {
    const { repoPath, w } = await setup(s)
    writeFileSync(join(w.path, 'r.txt'), 'r\n'); commitIn(w.path, 'r')
    const { pending } = await s.asAiguilleur('POST', `/workspaces/${w.id}/merge`)
    await s.stop()
    s = await startServer({ home: s.home })
    const p = (await s.state()).aiguilleur.pending.find(x => x.id === pending)
    assert.equal(p?.input.command, `Merge aig/${w.name} into main`)
    await s.api('POST', '/workspaces/aiguilleur/permission', { id: pending, allow: true })
    const rep = await waitFor(async () => (await s.log('aiguilleur')).find(e => e.type === 'cg_report' && e.ws === w.id), { what: 'the outcome' })
    assert.deepEqual([rep.ok, rep.key], [true, 'messages.merged'])
    assert.ok(existsSync(join(repoPath, 'r.txt')))
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, 'state.json'), 'utf8')).confirms, [], 'answered: gone from state.json')
  } finally { await s.stop() }
})

test('a confirmation a day old is dropped at startup, with one report', async () => {
  let s = await startServer()
  try {
    const { w } = await setup(s)
    const { pending } = await s.asAiguilleur('POST', `/workspaces/${w.id}/archive`)
    await s.stop()
    edit(s.home, st => { st.confirms[0].at -= 25 * 3600_000 })
    s = await startServer({ home: s.home })
    assert.ok(!(await s.state()).aiguilleur.pending.some(x => x.id === pending))
    const reps = (await s.log('aiguilleur')).filter(e => e.type === 'cg_report' && e.key === 'confirm.expired')
    assert.deepEqual(reps.map(r => [r.ok, r.vars]), [[false, { count: 1, list: [{ key: 'confirm.archive', vars: { name: w.name } }] }]])
    assert.ok(!(await s.ws(w.id)).archived)
  } finally { await s.stop() }
})
