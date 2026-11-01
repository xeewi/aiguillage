import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { startServer, setup, waitFor, tmp } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const toolResults = async id => (await srv.log(id)).flatMap(e => e.type === 'user' ? e.message.content.filter(c => c.type === 'tool_result') : [])
const pending = async id => (await srv.ws(id)).pending
const send = (id, text) => srv.api('POST', `/workspaces/${id}/send`, { text })
const waitPending = id => waitFor(async () => (await pending(id)).length && (await pending(id))[0], { what: 'pending permission' })
const answer = (id, body) => srv.api('POST', `/workspaces/${id}/permission`, body)
const mode = (id, permissionMode) => srv.api('PATCH', `/workspaces/${id}`, { permissionMode })

test('auto: tools inside the worktree are approved without asking', async () => {
  const { w } = await setup(srv)
  assert.equal(w.permissionMode, 'auto')
  assert.equal(await srv.turn(w.id, 'write inside.txt hello'), 'wrote inside.txt')
  assert.equal(readFileSync(join(w.path, 'inside.txt'), 'utf8'), 'hello\n')
  assert.deepEqual(await pending(w.id), [])
})

test('auto: Write outside the worktree is refused (absolute and ../ paths)', async () => {
  const { w } = await setup(srv)
  const outside = join(tmp('cgout-'), 'evil.txt')
  assert.match(await srv.turn(w.id, `write ${outside} x`), /^write failed/)
  assert.ok(!existsSync(outside))
  const rel = '../escaped.txt'
  await srv.turn(w.id, `write ${rel} x`)
  assert.ok(!existsSync(join(dirname(w.path), 'escaped.txt')))
  const results = await toolResults(w.id)
  assert.equal(results.filter(r => r.is_error && /outside your worktree/.test(r.content)).length, 2)
})

test('auto: Write through a symlink in the worktree pointing outside is refused', async () => {
  const { w } = await setup(srv)
  const outDir = tmp('cgout-')
  symlinkSync(outDir, join(w.path, 'link'))
  await srv.turn(w.id, 'write link/escaped.txt x')
  assert.ok(!existsSync(join(outDir, 'escaped.txt')), 'file written outside the worktree via symlink')
})

test('default (Demander): pending permission shows tool + input; approve writes the file', async () => {
  const { w } = await setup(srv)
  await mode(w.id, 'default')
  await send(w.id, 'write asked.txt yes')
  const p = await waitPending(w.id)
  assert.equal(p.tool, 'Write')
  assert.equal(p.input.file_path, 'asked.txt')
  assert.equal((await srv.ws(w.id)).busy, true)
  await answer(w.id, { id: p.id, allow: true })
  await srv.idle(w.id)
  assert.equal(readFileSync(join(w.path, 'asked.txt'), 'utf8'), 'yes\n')
  assert.deepEqual(await pending(w.id), [])
})

test('default (Demander): deny keeps the file away and the message reaches the agent', async () => {
  const { w } = await setup(srv)
  await mode(w.id, 'default')
  await send(w.id, 'write denied.txt no')
  const p = await waitPending(w.id)
  await answer(w.id, { id: p.id, allow: false, message: 'not this one' })
  await srv.idle(w.id)
  assert.ok(!existsSync(join(w.path, 'denied.txt')))
  assert.ok((await toolResults(w.id)).some(r => r.is_error && r.content === 'not this one'))
  const plain = await setup(srv)
  await mode(plain.w.id, 'default')
  await send(plain.w.id, 'write denied2.txt no')
  const p2 = await waitPending(plain.w.id)
  await answer(plain.w.id, { id: p2.id, allow: false })
  await srv.idle(plain.w.id)
  assert.ok((await toolResults(plain.w.id)).some(r => r.is_error && /Denied by the user/.test(r.content)), 'default deny message')
})

test('switching to auto approves what was pending', async () => {
  const { w } = await setup(srv)
  await mode(w.id, 'default')
  await send(w.id, 'write later.txt ok')
  await waitPending(w.id)
  await mode(w.id, 'auto')
  await srv.idle(w.id)
  assert.equal(readFileSync(join(w.path, 'later.txt'), 'utf8'), 'ok\n')
})

test('acceptEdits: edits inside the worktree go through without asking', async () => {
  const { w } = await setup(srv)
  await mode(w.id, 'acceptEdits')
  assert.equal(await srv.turn(w.id, 'write edits.txt fine'), 'wrote edits.txt')
  assert.ok(existsSync(join(w.path, 'edits.txt')))
  assert.equal((await srv.ws(w.id)).permissionMode, 'acceptEdits')
})

test('plan: approving the plan switches to auto', async () => {
  const { w } = await setup(srv)
  await mode(w.id, 'plan')
  await send(w.id, 'plan add a file')
  const p = await waitPending(w.id)
  assert.equal(p.tool, 'ExitPlanMode')
  assert.match(p.input.plan, /add a file/)
  await answer(w.id, { id: p.id, allow: true })
  await srv.idle(w.id)
  assert.equal((await srv.ws(w.id)).permissionMode, 'auto')
  assert.match((await srv.log(w.id)).filter(e => e.type === 'assistant').at(-1).message.content[0].text, /plan approved, mode now default/)
})

test('plan: rejecting with a message sends the feedback to the agent', async () => {
  const { w } = await setup(srv)
  await mode(w.id, 'plan')
  await send(w.id, 'plan something')
  const p = await waitPending(w.id)
  await answer(w.id, { id: p.id, allow: false, message: 'too big' })
  await srv.idle(w.id)
  assert.equal((await srv.log(w.id)).filter(e => e.type === 'assistant').at(-1).message.content[0].text, 'plan rejected: too big')
  assert.equal((await srv.ws(w.id)).permissionMode, 'plan')
})

test('answering an unknown permission id is a no-op', async () => {
  const { w } = await setup(srv)
  assert.deepEqual(await answer(w.id, { id: 'nope', allow: true }), {})
  assert.equal(await srv.turn(w.id, 'still fine'), 'ok: still fine')
})

test('legacy saved mode bypassPermissions behaves as auto (sandboxed)', async () => {
  const { w } = await setup(srv)
  await mode(w.id, 'bypassPermissions')
  assert.equal(await srv.turn(w.id, 'write legacy.txt ok'), 'wrote legacy.txt')
  const outside = join(tmp('cgout-'), 'x.txt')
  await srv.turn(w.id, `write ${outside} x`)
  assert.ok(!existsSync(outside))
  const env = JSON.parse((await srv.turn(w.id, 'env')).slice(5))
  assert.equal(env.mode, 'default', 'never launched with real bypassPermissions')
})
