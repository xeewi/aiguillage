// Telegram bridge end to end, against a fake Bot API: aiguilleur, turn reports, replies, permission buttons.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor } from '../helpers.mjs'

const ME = 42
const updates = [], sent = [], calls = []
let nextUpdate = 1, nextMsg = 100
const push = u => updates.push({ update_id: nextUpdate++, ...u })
const say = (text, extra = {}) => push({ message: { message_id: nextMsg++, chat: { id: ME }, from: { language_code: 'en' }, text, ...extra } })

const tg = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const b = JSON.parse(body || '{}'), method = req.url.split('/').pop()
  calls.push({ method, ...b })
  const ok = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })) }
  if (method === 'getUpdates') {
    await waitFor(() => updates.some(u => u.update_id >= b.offset), { timeout: 300 }).catch(() => {})
    return ok(updates.filter(u => u.update_id >= b.offset))
  }
  if (method === 'sendMessage') { const m = { message_id: nextMsg++, chat: { id: b.chat_id }, text: b.text }; sent.push({ ...b, message_id: m.message_id }); return ok(m) }
  if (method === 'getMe') {
    if (req.url.includes('/botbad/')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })) }
    return ok({ username: 'aig_bot' })
  }
  ok(true)
})

let srv
before(async () => {
  await new Promise(r => tg.listen(0, '127.0.0.1', r))
  srv = await startServer({ env: { AIGUILLAGE_TELEGRAM_API: `http://127.0.0.1:${tg.address().port}` } })
})
after(async () => { await srv.stop(); tg.close() })

const message = (fn, what) => waitFor(() => sent.find(fn), { what })

test('Settings: a bad token is refused; a good one gives a one-time link, and only its code links a chat', async () => {
  await assert.rejects(srv.api('POST', '/telegram', { token: 'bad' }), /refused this token/)
  assert.equal((await srv.state()).telegram.on, false)
  await srv.api('POST', '/telegram', { token: '1:x' })
  const { telegram } = await srv.state()
  assert.equal(telegram.token, undefined, 'the token never goes back to the page')
  assert.equal(telegram.link, `https://t.me/aig_bot?start=${telegram.code}`)
  push({ message: { message_id: nextMsg++, chat: { id: 7 }, text: '/start nope' } })
  await message(m => m.chat_id === 7 && /Settings → Telegram/.test(m.text), 'told how to link')
  say(`/start ${telegram.code}`, { chat: { id: ME, first_name: 'Ada' } })
  await message(m => m.chat_id === ME && m.text.startsWith('Linked!'), 'linked')
  const after = (await srv.state()).telegram
  assert.deepEqual([after.linked, after.chatName, after.link, after.remote], [true, 'Ada', undefined, true], 'linking from the phone turns remote mode on')
  await waitFor(() => calls.some(c => c.method === 'setMyCommands' && c.commands.some(x => x.command === 'remote')), { what: 'command menu' })
})

test('a plain message goes to the aiguilleur, which runs outside every repo with its own briefing', async () => {
  say('how are things?')
  await message(m => m.text === 'ok: [Telegram] how are things?', 'aiguilleur reply')
  const run = srv.fakeArgv().find(a => a.cwd?.endsWith('/aiguilleur'))
  assert.ok(run, 'aiguilleur started in ~/.aiguillage/aiguilleur')
  assert.match(run.argv[run.argv.indexOf('--append-system-prompt') + 1], new RegExp(`You are the aiguilleur [\\s\\S]*127\\.0\\.0\\.1:${srv.port}`))
  const st = await srv.state()
  assert.ok(!st.workspaces.some(w => w.id === 'aiguilleur') && st.aiguilleur.aiguilleur, 'apart from the workspaces')
})

test("a workspace's finished turn is reported; replying to the report talks to that agent", async () => {
  const { repo, w } = await setup(srv)
  await srv.turn(w.id, 'hi')
  const report = await message(m => m.text.startsWith(`✅ ${repo.name} / `) && m.text.endsWith('ok: hi'), 'turn report')
  say('again', { reply_to_message: { message_id: report.message_id } })
  await message(m => m.text.endsWith('ok: again'), 'second report')
  assert.ok((await srv.log(w.id)).some(e => e.type === 'cg_user' && e.text === 'again'))
})

test('a permission request comes with buttons; Allow lets the tool run', async () => {
  const { w } = await setup(srv)
  await srv.api('PATCH', `/workspaces/${w.id}`, { permissionMode: 'default' })
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'bash echo hi' })
  const ask = await message(m => m.reply_markup && m.text.includes('echo hi'), 'permission message')
  const [allow] = ask.reply_markup.inline_keyboard[0]
  push({ callback_query: { id: 'cb1', data: allow.callback_data, from: {}, message: { message_id: ask.message_id, chat: { id: ME } } } })
  await waitFor(async () => (await srv.log(w.id)).some(e => e.type === 'result'), { what: 'turn done after Allow' })
  await waitFor(() => calls.some(c => c.method === 'editMessageReplyMarkup' && c.message_id === ask.message_id), { what: 'buttons removed' })
})

test('/status lists the workspaces; once linked, other chats are ignored', async () => {
  const before = sent.filter(m => m.chat_id === 7).length
  push({ message: { message_id: nextMsg++, chat: { id: 7 }, text: 'hello?' } })
  say('/status')
  const s = await message(m => m.text.includes('💤'), 'status')
  assert.equal(s.chat_id, ME)
  assert.equal(sent.filter(m => m.chat_id === 7).length, before)
})

test('remote mode off: nothing pushed, messages still go through; /remote from the phone catches up, both ways', async () => {
  const { repo, w } = await setup(srv)
  await srv.api('PATCH', '/telegram', { remote: false })
  assert.equal((await srv.state()).telegram.remote, false)
  await message(m => m.text.startsWith('Remote mode off'), 'told it is off')
  await srv.turn(w.id, 'quietly')
  await srv.api('PATCH', `/workspaces/${w.id}`, { permissionMode: 'default' })
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'bash echo waiting' })
  await waitFor(async () => (await srv.ws(w.id)).pending.length, { what: 'a pending request' })
  say('still there?')
  await message(m => m.text === 'ok: [Telegram] still there?', 'the aiguilleur answers anyway')
  assert.ok(!sent.some(m => m.text.endsWith('ok: quietly') || m.text.includes('echo waiting')), 'no report nor request while off')
  say('/remote')
  await message(m => m.text.startsWith('📡 Remote mode on') && m.text.includes(repo.name), 'catch-up with the status')
  await message(m => m.text.endsWith('ok: quietly'), 'the missed report')
  await message(m => m.reply_markup && m.text.includes('echo waiting'), 'the waiting request, with its buttons')
  assert.equal((await srv.state()).telegram.remote, true, 'the window sees it on')
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
})

test('Disconnect stops the bot', async () => {
  await srv.api('POST', '/telegram', { token: '' })
  assert.deepEqual((await srv.state()).telegram, { on: false, linked: false, remote: false })
})

test("a finished turn adds what's worth keeping to the project's journal, in the aiguilleur's folder", async () => {
  const { repo, w } = await setup(srv)
  await srv.turn(w.id, 'note this')
  const file = join(srv.home, 'aiguilleur', 'projects', repo.name + '.md')
  const { name } = await srv.ws(w.id)
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes(`(${name}): `), { what: 'journal line' })
  assert.match(readFileSync(file, 'utf8'), /^# repo\n\nPath: .*\n\n## Journal\n- \d{4}-\d\d-\d\d \(/)
})
