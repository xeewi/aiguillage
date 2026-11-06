import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, git } from '../helpers.mjs'

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
  await srv.api('POST', `/workspaces/${w.id}/permission`, { id: p.id, allow: true })
  await srv.idle(w.id)
  const m = await srv.api('GET', '/metrics?days=14')
  assert.equal(m.permissions.n, 1)
  assert.ok(m.permissions.medianWaitMs >= 0)
})
