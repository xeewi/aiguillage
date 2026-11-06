import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, socket, lastText } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

test('chat: message → streamed deltas, logged events, title, session memory', async () => {
  const { w } = await setup(srv)
  const s = socket(srv.base); await s.open
  const reply = await srv.turn(w.id, 'hello there')
  assert.equal(reply, 'ok: hello there')
  const log = await srv.log(w.id)
  assert.deepEqual(log.map(e => e.type), ['cg_user', 'system', 'assistant', 'result'])
  assert.ok(log[0].cp?.tree, 'a checkpoint is taken before each message')
  assert.ok(s.msgs.some(m => m.t === 'delta' && m.ws === w.id), 'partial text is streamed')
  assert.equal(await srv.turn(w.id, 'memory'), 'memory: hello there | memory')
  s.close()
})

test('subagents: listed while they work, past the end of the turn; their messages nest under the Agent call', async () => {
  const { w } = await setup(srv)
  assert.equal(await srv.turn(w.id, 'subagent 1500'), 'subagent launched')
  const [task] = (await srv.ws(w.id)).tasks
  assert.deepEqual(task, { id: task.id, taskId: task.taskId, description: 'Look around', type: 'general-purpose', background: true, last: 'Running List files', shell: false })
  await waitFor(async () => !(await srv.ws(w.id)).tasks.length, { what: 'subagent done' })
  const log = await srv.log(w.id)
  assert.ok(log.some(e => e.type === 'task' && e.tool_use_id === task.id && e.status === 'completed'))
  assert.ok(log.some(e => e.parent_tool_use_id === task.id && e.message.content[0].text === 'subagent done'))
})

test('subagents: one can be stopped alone; it ends « stopped » and the session goes on', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'subagent 60000')
  const [task] = (await srv.ws(w.id)).tasks
  await srv.api('POST', `/workspaces/${w.id}/stop-task`, { id: task.id })
  await waitFor(async () => !(await srv.ws(w.id)).tasks.length, { what: 'subagent stopped' })
  assert.ok((await srv.log(w.id)).some(e => e.type === 'task' && e.tool_use_id === task.id && e.status === 'stopped'))
  // The turn the CLI starts to say so ends first: under load it could otherwise end inside the next message's wait.
  await waitFor(async () => (await srv.log(w.id)).filter(e => e.type === 'result').length === 2, { what: 'the turn announcing it' })
  assert.equal(await srv.turn(w.id, 'still here'), 'ok: still here')
})

test('background shells: listed while they run, past the end of the turn; stop_task ends one « stopped »', async () => {
  const { w } = await setup(srv)
  assert.equal(await srv.turn(w.id, 'shell 60000'), 'shell launched')
  const [task] = (await srv.ws(w.id)).tasks
  assert.deepEqual(task, { id: task.id, taskId: task.taskId, description: 'Start the dev server', type: '', background: true, last: '', shell: true })
  await srv.api('POST', `/workspaces/${w.id}/stop-task`, { id: task.id })
  await waitFor(async () => !(await srv.ws(w.id)).tasks.length, { what: 'shell stopped' })
  assert.ok((await srv.log(w.id)).some(e => e.type === 'task' && e.tool_use_id === task.id && e.status === 'stopped'))
})

// « Working » follows the CLI's turns, not a count of messages sent: the CLI starts turns of its own and folds messages in.
test('working: the turn a finished subagent starts on its own shows the agent working', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'subagent 200')
  await waitFor(async () => (await srv.ws(w.id)).busy, { what: 'notification turn shown as working' })
  await srv.idle(w.id)
  assert.equal(lastText(await srv.log(w.id)), 'the subagent completed')
})

test('working: a message landing behind a background task\'s empty turn stays working until its own turn ends', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'race' })
  await waitFor(async () => (await srv.log(w.id)).some(e => e.type === 'result' && e.num_turns === 0), { what: 'empty turn' })
  assert.ok((await srv.ws(w.id)).busy, 'still working after the empty turn')
  await srv.idle(w.id)
  assert.equal(lastText(await srv.log(w.id)), 'raced')
})

test('working: a message sent mid-turn joins it; one result, then idle', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'merge' })
  await waitFor(async () => (await srv.log(w.id)).some(e => e.message?.content?.[0]?.type === 'tool_use'), { what: 'tool running' })
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'also this' })
  await waitFor(async () => lastText(await srv.log(w.id)) === 'merged: also this', { what: 'merged reply' })
  await srv.idle(w.id, 3000)
})

test('naming: Claude names the workspace from the first message; a rename sticks; empty goes back to auto', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'fix the login page')
  await waitFor(async () => (await srv.ws(w.id)).title === 'Named: fix the login page', { what: 'name from Claude' })
  await srv.turn(w.id, 'second message')
  await srv.api('PATCH', `/workspaces/${w.id}`, { title: '  Login   page ' })
  assert.equal((await srv.ws(w.id)).title, 'Login page')
  await srv.api('PATCH', `/workspaces/${w.id}`, { title: '' })
  await srv.turn(w.id, 'third')
  await waitFor(async () => (await srv.ws(w.id)).title === 'Named: third', { what: 'renamed from the next message' })
})

test('naming: when the CLI fails, the truncated first message stays', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'crash' }) // the agent crashes too
  await waitFor(async () => (await srv.log(w.id)).some(e => e.type === 'cg_error'), { what: 'agent exit' })
  await new Promise(r => setTimeout(r, 500)) // the naming call fails in about the same time
  assert.equal((await srv.ws(w.id)).title, 'crash')
})

test('naming: titles are capped at 5 words, the provisional one marks the cut', async () => {
  const { words } = await import('../../lib/agent.js')
  assert.equal(words('  fix   the login page '), 'fix the login page')
  assert.equal(words('Lorsque je vais dans l\'onglet run et que je clique', '…'), 'Lorsque je vais dans l\'onglet…')
  assert.equal(words('Named: when I open the run tab'), 'Named: when I open the')
})

test('chat: one process per workspace, resumed with the same session after a restart', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'first')
  const sid = (await srv.ws(w.id)).sessionId
  assert.ok(sid)
  await srv.stop()
  srv = await startServer({ home: srv.home })
  assert.equal((await srv.log(w.id)).filter(e => e.type === 'cg_user').length, 1, 'history survives restart')
  assert.equal(await srv.turn(w.id, 'memory'), 'memory: first | memory')
  const last = srv.fakeArgv().at(-1).argv
  assert.equal(last[last.indexOf('--resume') + 1], sid)
})

test('chat: agent process gets workspace env, briefing, disallowed AskUserQuestion, not nested', async () => {
  const { w } = await setup(srv)
  const env = JSON.parse((await srv.turn(w.id, 'env')).slice(5))
  assert.equal(env.AIGUILLAGE_PORT, String(w.port))
  assert.equal(env.AIGUILLAGE_WORKSPACE_NAME, w.name)
  assert.equal(env.cwd, w.path)
  assert.equal(env.disallowed, 'AskUserQuestion')
  assert.equal(env.mode, 'default', 'auto mode runs the CLI in default mode so every tool call reaches Aiguillage')
  assert.match(env.prompt, new RegExp(w.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(env.prompt, new RegExp(`${w.port}-${w.port + 9}`))
  assert.equal(env.CLAUDECODE, null)
})

test('chat: a crashing agent is reported, and the next message starts a fresh process', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'crash' })
  await waitFor(async () => (await srv.log(w.id)).some(e => e.type === 'cg_error'), { what: 'cg_error' })
  const err = (await srv.log(w.id)).find(e => e.type === 'cg_error')
  assert.match(err.text, /code 3/)
  assert.match(err.text, /simulated crash/)
  assert.equal((await srv.ws(w.id)).busy, false)
  assert.equal(await srv.turn(w.id, 'again'), 'ok: again')
})

test('chat: interrupt stops a running turn', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'slow' })
  await waitFor(async () => (await srv.ws(w.id)).busy, { what: 'busy' })
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
  await srv.idle(w.id, 4000)
  const log = await srv.log(w.id)
  assert.ok(log.some(e => e.type === 'user' && JSON.stringify(e.message.content).includes('interrupted')))
  assert.ok(lastText(log).split('tick').length < 60, 'stopped well before the end')
})

test('chat: messages sent while busy are queued and all answered', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'one' })
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'two' })
  await waitFor(async () => (await srv.log(w.id)).filter(e => e.type === 'result').length === 2, { what: '2 results' })
  await srv.idle(w.id)
  const texts = (await srv.log(w.id)).filter(e => e.type === 'assistant').map(e => e.message.content[0].text)
  assert.deepEqual(texts, ['ok: one', 'ok: two'])
})

test('chat: model, effort and mode changes restart an idle agent with the new flags', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'hi')
  await srv.api('PATCH', `/workspaces/${w.id}`, { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' })
  const env = JSON.parse((await srv.turn(w.id, 'env')).slice(5))
  assert.equal(env.model, 'opus')
  assert.equal(env.effort, 'high')
  assert.equal(env.mode, 'acceptEdits')
  assert.equal(existsSync(join(srv.home, 'state.json')), true)
  const saved = JSON.parse(readFileSync(join(srv.home, 'state.json'), 'utf8')).workspaces.find(x => x.id === w.id)
  assert.equal(saved.model, 'opus')
})
