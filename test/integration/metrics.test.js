import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, git, sleep } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const commitIn = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }

test('a turn and a merge conflict show up in /api/metrics', async () => {
  const { repoPath, w } = await setup(srv, { 'README.md': 'base\n' })
  await srv.turn(w.id, 'hello')
  writeFileSync(join(w.path, 'README.md'), 'workspace\n'); commitIn(w.path, 'ws')
  writeFileSync(join(repoPath, 'README.md'), 'main\n'); commitIn(repoPath, 'main')
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/merge`), /Conflict/)
  const m = await srv.api('GET', '/metrics?days=14')
  assert.equal(m.turns.n, 1)
  assert.equal(m.cost.byWs[w.id], 0.01) // the fake CLI reports total_cost_usd 0.01
  assert.deepEqual(m.merges, { n: 1, conflicts: 1 })
})

test('a permission answered from the page is counted with its wait', async () => {
  const { w } = await setup(srv)
  await srv.api('PATCH', `/workspaces/${w.id}`, { permissionMode: 'default' })
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'bash echo hi' })
  const p = await waitFor(async () => (await srv.ws(w.id)).pending[0], { what: 'pending permission' })
  await sleep(300) // the wait is measured from when the request appeared
  await srv.api('POST', `/workspaces/${w.id}/permission`, { id: p.id, allow: true })
  await srv.idle(w.id)
  const m = await srv.api('GET', '/metrics?days=14')
  assert.equal(m.permissions.n, 1)
  assert.ok(m.permissions.medianWaitMs >= 250, `${m.permissions.medianWaitMs} ms`)
})

test('a turn you interrupted is counted, not as a failure', async () => {
  const { w } = await setup(srv)
  const before = (await srv.api('GET', '/metrics?days=14')).turns
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'slow' })
  await waitFor(async () => (await srv.ws(w.id)).busy, { what: 'working' })
  await sleep(300) // the fake is streaming: the interrupt lands inside the turn
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
  const res = await waitFor(async () => (await srv.log(w.id)).find(e => e.type === 'result'), { what: 'the interrupted result' })
  assert.equal(res.is_error, true, 'the CLI ends an interrupted turn as an error')
  const m = (await srv.api('GET', '/metrics?days=14')).turns
  assert.deepEqual([m.n, m.failed], [before.n + 1, before.failed])
})

test("a worker's report is counted, and whether it ended with its block", async () => {
  const { w } = await setup(srv)
  const reports = async () => (await srv.api('GET', '/metrics?days=14')).reports
  const before = await reports()
  await srv.turn(w.id, 'report done All good')
  await srv.turn(w.id, 'no block here')
  await waitFor(async () => (await reports()).n === before.n + 2, { what: 'two reports counted' })
  assert.equal((await reports()).withBlock, before.withBlock + 1)
})

test("a turn the CLI starts on its own after the agent's process died is timed from its own start", async () => {
  // The process is started again without a message (the composer's « / » list), resumes, and begins a turn itself.
  const own = await startServer({ env: { FAKE_CLAUDE_SILENT_INIT: '1', FAKE_CLAUDE_WAKES: '1' } })
  try {
    const timed = id => readFileSync(join(own.home, 'metrics.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.kind === 'turn' && e.ws === id)
    const woke = async (id, since) => {
      own.api('GET', `/workspaces/${id}/commands`).catch(() => {}) // answers only after 30 s (no command list): not awaited
      return waitFor(() => timed(id).find(e => e.t > since), { what: 'the turn it began itself' })
    }
    // The CLI exits mid-turn…
    const a = (await setup(own)).w
    await own.api('POST', `/workspaces/${a.id}/send`, { text: 'crash' })
    await waitFor(async () => (await own.log(a.id)).some(e => e.type === 'cg_error'), { what: 'the crash' })
    await sleep(1200)
    assert.ok((await woke(a.id, Date.now())).ms < 1000, 'not timed from the crashed turn')
    // …or Aiguillage stops it (an interrupt it ignores: stopped after 5 s).
    const b = (await setup(own)).w
    await own.api('POST', `/workspaces/${b.id}/send`, { text: 'deaf 20000' })
    await waitFor(async () => (await own.ws(b.id)).busy, { what: 'working' })
    await own.api('POST', `/workspaces/${b.id}/interrupt`)
    await own.idle(b.id, 8000)
    assert.ok((await woke(b.id, Date.now())).ms < 1000, 'not timed from the stopped turn')
  } finally { await own.stop() }
})
