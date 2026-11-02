import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, setup, waitFor, socket } from '../helpers.mjs'

let srv
// bash, not the user's zsh: a dotfile-less HOME would trigger zsh's interactive first-run wizard.
before(async () => { srv = await startServer({ env: { SHELL: '/bin/bash' } }) })
after(() => srv.stop())

test('the « / » menu lists the session\'s own commands, asked to the agent before any message', async () => {
  const { w } = await setup(srv)
  const list = await srv.api('GET', `/workspaces/${w.id}/commands`)
  assert.deepEqual(list.map(c => c.name), ['clear', 'compact', 'context', 'model', 'code-review'], 'internal ones left out')
  assert.deepEqual(list.find(c => c.name === 'code-review'), { name: 'code-review', description: 'Review the current diff', hint: '[low|high]', aliases: ['review'] })
  // The agent it started is the one the first message then uses.
  const n = srv.fakeArgv().length
  assert.equal(await srv.turn(w.id, 'hi'), 'ok: hi')
  assert.equal(srv.fakeArgv().length, n, 'no second launch')
})

test('/model and /effort typed in the chat stick to the workspace once the CLI confirms them', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, '/model fable')
  assert.equal((await srv.ws(w.id)).model, 'fable')
  await srv.turn(w.id, '/model nope')
  assert.equal((await srv.ws(w.id)).model, 'fable', 'refused by the CLI: unchanged')
  await srv.turn(w.id, '/effort high')
  assert.equal((await srv.ws(w.id)).effort, 'high')
  // A restart (here: a mode change while idle) keeps them.
  await srv.api('PATCH', `/workspaces/${w.id}`, { permissionMode: 'plan' })
  await srv.turn(w.id, 'hi')
  const argv = srv.fakeArgv().at(-1).argv
  assert.equal(argv[argv.indexOf('--model') + 1], 'fable')
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high')
  await srv.turn(w.id, '/model default')
  assert.equal((await srv.ws(w.id)).model, '')
  await srv.turn(w.id, '/effort auto')
  assert.equal((await srv.ws(w.id)).effort, '')
})

test('a full-screen command runs in the interactive Claude Code, on the same session; the chat waits for it to quit', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'hello')
  assert.match(await srv.turn(w.id, '/permissions'), /isn't available in this environment/)
  const sid = (await srv.ws(w.id)).sessionId
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/terminal-command`, { command: '/x; touch pwned' }), /Not a command/)

  const s = socket(srv.base); await s.open
  await srv.api('POST', `/workspaces/${w.id}/terminal-command`, { command: '/permissions' })
  await waitFor(async () => (await srv.ws(w.id)).claudeTerm, { what: 'claudeTerm' })
  await waitFor(() => srv.fakeArgv().at(-1).argv.includes('/permissions'), { what: 'interactive launch' })
  assert.deepEqual(srv.fakeArgv().at(-1).argv, ['--resume', sid, '/permissions'])
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/send`, { text: 'hi' }), /Terminal tab/)

  s.send({ t: 'term:open', key: `${w.id}:claude` })
  s.send({ t: 'term:in', key: `${w.id}:claude`, data: '/exit\r' })
  await waitFor(async () => !(await srv.ws(w.id)).claudeTerm, { what: 'terminal Claude Code quit' })
  s.close()
  assert.equal(await srv.turn(w.id, 'memory'), 'memory: hello | memory', 'chat resumes the same conversation')
})
