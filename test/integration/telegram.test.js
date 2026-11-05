// Telegram bridge end to end, against a fake Bot API: aiguilleur, turn reports, replies, permission buttons.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, tmp } from '../helpers.mjs'

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
  ok(true)
})

let srv
before(async () => {
  await new Promise(r => tg.listen(0, '127.0.0.1', r))
  const home = tmp('cghome-')
  writeFileSync(join(home, 'settings.toml'), `[telegram]\ntoken = "1:x"\nchat = ${ME}\n`)
  srv = await startServer({ home, env: { AIGUILLAGE_TELEGRAM_API: `http://127.0.0.1:${tg.address().port}` } })
})
after(async () => { await srv.stop(); tg.close() })

const message = (fn, what) => waitFor(() => sent.find(fn), { what })

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

test('/status lists the workspaces; other chats are ignored', async () => {
  push({ message: { message_id: nextMsg++, chat: { id: 7 }, text: 'hello?' } })
  say('/status')
  const s = await message(m => m.text.includes('💤'), 'status')
  assert.equal(s.chat_id, ME)
  assert.ok(!sent.some(m => m.chat_id === 7))
})

test("a finished turn adds what's worth keeping to the project's journal, in the aiguilleur's folder", async () => {
  const { repo, w } = await setup(srv)
  await srv.turn(w.id, 'note this')
  const file = join(srv.home, 'aiguilleur', 'projects', repo.name + '.md')
  const { name } = await srv.ws(w.id)
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes(`(${name}): `), { what: 'journal line' })
  assert.match(readFileSync(file, 'utf8'), /^# repo\n\nPath: .*\n\n## Journal\n- \d{4}-\d\d-\d\d \(/)
})
