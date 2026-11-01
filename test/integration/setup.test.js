// First-run checklist: GET /api/doctor and the fixed commands of POST /api/setup.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, socket, waitFor, tmp } from '../helpers.mjs'

const srv = await startServer({ env: { FAKE_CLAUDE_LOGGED_OUT: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
after(() => srv.stop())

test('doctor: finds git and claude, reports a fresh install as logged out', async () => {
  assert.deepEqual(await srv.api('GET', '/doctor'), { git: true, claude: true, loggedIn: false })
})

test('setup: only known steps; the step runs in the "setup" terminal', async () => {
  await assert.rejects(srv.api('POST', '/setup', { step: 'rm -rf /' }), e => e.status === 400)
  const ws = socket(srv.base); await ws.open
  await srv.api('POST', '/setup', { step: 'login' })
  await waitFor(() => ws.msgs.some(m => m.t === 'term:exit' && m.key === 'setup'), { what: 'setup exit' })
  const out = ws.msgs.filter(m => m.key === 'setup').map(m => m.data ?? '').join('')
  assert.match(out, /auth login/)
  ws.close()
})

test('add repo: a plain folder is refused, then turned into a repo with its files committed on request', async () => {
  const dir = tmp('cgplain-'); writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
  await assert.rejects(srv.api('POST', '/repos', { path: dir }), e => e.status === 400)
  const repo = await srv.api('POST', '/repos', { path: dir, init: true })
  const w = await srv.api('POST', '/workspaces', { repoId: repo.id })
  assert.ok(existsSync(join(w.path, 'index.html')))
})

test('add repo: never turns the home folder into a repo', async () => {
  await assert.rejects(srv.api('POST', '/repos', { path: '~', init: true }), e => e.status === 400)
  assert.ok(!existsSync(join(srv.home, '.git')))
})
