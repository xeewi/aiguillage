// The watchdog (lib/agent.js stalled) and the agent cap's queue (server.js sendTo / drain).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, sleep } from '../helpers.mjs'

const env = { AIGUILLAGE_STALL_MS: '300', AIGUILLAGE_WATCH_MS: '100' }
let srv
before(async () => { srv = await startServer({ env }) })
after(() => srv.stop())

const stalls = (s, id) => s.log('aiguilleur').then(l => l.filter(e => e.type === 'cg_report' && e.ws === id && e.stall))
const results = (s, id) => s.log(id).then(l => l.filter(e => e.type === 'result').length)
const cap = (s, maxAgents) => s.api('PATCH', '/defaults', { maxAgents })

test('a silent agent gets one ⏸ report « no sign of life », and keeps running', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'hang 1500' })
  const [r] = await waitFor(() => stalls(srv, w.id).then(l => l.length && l), { what: 'stall report' })
  assert.equal(r.status, 'blocked')
  assert.equal(r.stall, 'silent')
  assert.match(r.text, /No sign of life/)
  assert.ok((await srv.ws(w.id)).busy, 'not interrupted')
  await waitFor(() => results(srv, w.id), { what: 'the turn ends' })
  assert.match((await srv.log(w.id)).findLast(e => e.type === 'assistant').message.content[0].text, /woke/)
  assert.equal((await stalls(srv, w.id)).length, 1, 'once per turn')
})

test('the same tool call three times in a row is reported as a loop', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'loop')
  const l = await waitFor(() => stalls(srv, w.id).then(l => l.length && l), { what: 'loop report' })
  assert.deepEqual(l.map(r => r.stall), ['loop'])
})

test('maxAgents 1: a second workspace\'s message is queued, sent when the first one ends', async () => {
  const { w: a, repo } = await setup(srv)
  const b = await srv.api('POST', '/workspaces', { repoId: repo.id })
  await cap(srv, 1)
  try {
    await srv.api('POST', `/workspaces/${a.id}/send`, { text: 'hang 1200' })
    await waitFor(async () => (await srv.ws(a.id)).busy, { what: 'a working' })
    assert.deepEqual(await srv.api('POST', `/workspaces/${b.id}/send`, { text: 'second' }), { queued: true, reason: 'cap' })
    assert.equal((await srv.ws(b.id)).queued.length, 1)
    assert.ok(!(await srv.log(b.id)).some(e => e.type === 'cg_user'), 'not sent yet')
    await waitFor(() => results(srv, a.id), { what: 'a ends' })
    await waitFor(() => results(srv, b.id), { what: 'b sent and answered' })
    assert.match((await srv.log(b.id)).findLast(e => e.type === 'assistant').message.content[0].text, /ok: second/)
    assert.ok(!(await srv.ws(b.id)).queued?.length)
  } finally { await cap(srv, 5) }
})

test('the queue survives a restart and is sent once a slot is free', async () => {
  let s = await startServer({ env })
  try {
    const { w: a, repo } = await setup(s)
    const b = await s.api('POST', '/workspaces', { repoId: repo.id })
    await cap(s, 1)
    await s.api('POST', `/workspaces/${a.id}/send`, { text: 'hang 10000' })
    await waitFor(async () => (await s.ws(a.id)).busy, { what: 'a working' })
    assert.equal((await s.api('POST', `/workspaces/${b.id}/send`, { text: 'after restart' })).queued, true)
    await s.stop()
    const saved = JSON.parse(readFileSync(join(s.home, 'state.json'), 'utf8')).workspaces.find(w => w.id === b.id)
    assert.equal(saved.queued[0].text, 'after restart')
    s = await startServer({ home: s.home, env })
    await waitFor(() => results(s, b.id), { what: 'b sent after the restart' })
    assert.match((await s.log(b.id)).findLast(e => e.type === 'assistant').message.content[0].text, /ok: after restart/)
    assert.ok(!(await s.ws(b.id)).queued?.length)
  } finally { await s.stop() }
})

test('a message to an agent already working is never queued', async () => {
  const { w } = await setup(srv)
  await cap(srv, 1)
  try {
    await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'hang 800' })
    await waitFor(async () => (await srv.ws(w.id)).busy, { what: 'working' })
    assert.deepEqual(await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'more' }), {})
    assert.equal((await srv.log(w.id)).filter(e => e.type === 'cg_user').length, 2)
    await waitFor(async () => (await results(srv, w.id)) === 2, { what: 'both answered' })
  } finally { await cap(srv, 5) }
})
