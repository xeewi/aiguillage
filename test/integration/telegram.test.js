// Telegram bridge end to end, against a fake Bot API: the aiguilleur as the one interlocutor (turn reports, replies,
// one conversation in the window and on Telegram), permission buttons, the pinned board, Markdown rendered by Telegram.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor } from '../helpers.mjs'

const ME = 42
const updates = [], sent = [], calls = []
let nextUpdate = 1, nextMsg = 100
const push = u => updates.push({ update_id: nextUpdate++, ...u })
const say = (text, extra = {}) => push({ message: { message_id: nextMsg++, chat: { id: ME }, from: { language_code: 'en' }, text, ...extra } })

const tg = http.createServer(async (req, res) => {
  const ok = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })) }
  let body = ''
  for await (const c of req) body += c
  // A file's download: GET <api>/file/bot<token>/<file_path>, its bytes.
  if (req.url.includes('/file/bot')) { res.writeHead(200); return res.end(`bytes of ${req.url.split('/').pop()}`) }
  const method = req.url.split('/').pop()
  // An upload (sendPhoto, sendDocument…): multipart, kept raw. A photo Telegram refuses: thin.png.
  if (req.headers['content-type']?.startsWith('multipart/')) {
    calls.push({ method, body })
    if (method === 'sendPhoto' && body.includes('thin.png')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' })) }
    return ok({ message_id: nextMsg++ })
  }
  const b = JSON.parse(body || '{}')
  calls.push({ method, ...b })
  if (method === 'getFile') return ok({ file_id: b.file_id, file_path: `photos/${b.file_id}.jpg` })
  if (method === 'getUpdates') {
    await waitFor(() => updates.some(u => u.update_id >= b.offset), { timeout: 300 }).catch(() => {})
    return ok(updates.filter(u => u.update_id >= b.offset))
  }
  if (method === 'sendRichMessage' && b.rich_message.markdown.includes('UNPARSABLE')) {
    res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, description: "Bad Request: can't parse rich message" }))
  }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    const m = { message_id: nextMsg++, chat: { id: b.chat_id } }
    sent.push({ ...b, text: b.text ?? b.rich_message.markdown, method, message_id: m.message_id }); return ok(m)
  }
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
  const board = await message(m => m.text === 'No active workspace.' && m.disable_notification, 'the board')
  await waitFor(() => calls.some(c => c.method === 'pinChatMessage' && c.message_id === board.message_id), { what: 'board pinned' })
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

test("a workspace's finished turn is the aiguilleur's report; a reply to it goes to the aiguilleur, saying which agent", async () => {
  const { repo, w } = await setup(srv)
  await srv.turn(w.id, 'hi')
  const report = await message(m => m.text.startsWith(`**✅ ${repo.name} / `) && m.text.endsWith('ok: hi'), 'turn report')
  const card = (await srv.log('aiguilleur')).find(e => e.type === 'cg_report' && e.ws === w.id)
  assert.deepEqual([card.ok, card.text, report.text.split('\n')[0], report.method], [true, 'ok: hi', `**✅ ${card.label}**`, 'sendRichMessage'],
    'the same report in the window; Telegram renders its Markdown')
  say('again', { reply_to_message: { message_id: report.message_id } })
  // The fake CLI echoes what its model reads: the unread report, then the reply and which agent it answers.
  const answer = await message(m => m.text.includes(`[Telegram] [Reply to the report of ${repo.name} / `) && m.text.endsWith(`(id ${w.id})] again`), "the aiguilleur's answer")
  assert.match(answer.text, new RegExp(`^ok: \\[Reports from the agents since your last message\\]\\n\\n✅ ${repo.name} / [^\\n]+\\n\\nok: hi\\n\\(workspace id ${w.id}\\)`))
  const said = (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_user')
  assert.deepEqual([said.text, said.via], ['again', 'telegram'], 'the window shows what the user wrote, marked as from Telegram')
  assert.ok(!(await srv.log(w.id)).some(e => e.type === 'cg_user' && e.text === 'again'), 'not straight to the agent')
})

test('remote mode: what is typed to the aiguilleur at the Mac shows on Telegram too, with its answer', async () => {
  await srv.turn('aiguilleur', 'from the desk')
  await message(m => m.text === '🖥 You, at the Mac:\n\nfrom the desk', 'the message, mirrored')
  await message(m => m.text === 'ok: from the desk', 'its answer')
})

test('a permission request comes with buttons; Allow lets the tool run', async () => {
  const { w } = await setup(srv)
  await srv.api('PATCH', `/workspaces/${w.id}`, { permissionMode: 'default' })
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'bash echo hi' })
  const ask = await message(m => m.reply_markup && m.text.includes('```\necho hi\n```'), 'permission message, the command as code')
  const [allow, deny] = ask.reply_markup.inline_keyboard[0]
  assert.deepEqual([allow.style, deny.style], ['success', 'danger'])
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
  await srv.turn('aiguilleur', 'at my desk')
  say('still there?')
  await message(m => m.text.endsWith('[Telegram] still there?'), 'the aiguilleur answers anyway')
  assert.ok(!sent.some(m => m.text.endsWith('ok: quietly') || m.text.includes('echo waiting') || m.text.includes('at my desk')),
    'no report, request nor window conversation while off')
  say('/remote')
  await message(m => m.text.startsWith('📡 Remote mode on'), 'told it is on')
  await message(m => m.text.includes(repo.name) && m.text.includes('🔐') && m.disable_notification, 'a new board, where every workspace stands')
  await message(m => m.text.endsWith('ok: quietly'), 'the missed report')
  await message(m => m.reply_markup && m.text.includes('echo waiting'), 'the waiting request, with its buttons')
  assert.equal((await srv.state()).telegram.remote, true, 'the window sees it on')
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
})

test('the board follows the agents in place: who works, on what, who asks', async () => {
  const { repo, w } = await setup(srv)
  const before = sent.length
  say('/status')
  const board = await message(m => sent.indexOf(m) >= before && m.disable_notification, 'a new board')
  await waitFor(() => calls.some(c => c.method === 'pinChatMessage' && c.message_id === board.message_id), { what: 'pinned' })
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'slow' })
  const edits = () => calls.filter(c => c.method === 'editMessageText' && c.message_id === board.message_id)
  await waitFor(() => edits().some(c => /^[^\n]*⏳ 1 working/.test(c.text) && c.text.includes(`\n⏳ ${repo.name} / `)), { what: 'shown working, counted in the first line' })
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
  await srv.idle(w.id)
  await waitFor(() => !edits().at(-1).text.includes('⏳'), { what: 'back to idle' })
  say('/status')
  await waitFor(() => calls.some(c => c.method === 'deleteMessage' && c.message_id === board.message_id), { what: 'the old board replaced' })
})

test('a text Telegram refuses to render goes again as plain text', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'UNPARSABLE')
  await message(m => m.method === 'sendMessage' && m.text.endsWith('ok: UNPARSABLE'), 'the report, plain')
})

test('photos, an album, a document from Telegram reach the aiguilleur as attachments; it passes them on to an agent', async () => {
  const { w } = await setup(srv)
  const said = text => waitFor(async () => (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_user' && e.text === text), { what: text })
  say(undefined, { photo: [{ file_id: 'small', file_size: 9 }, { file_id: 'big', file_size: 99 }], caption: 'look' })
  const photo = (await said('look')).files
  assert.equal(photo.length, 1)
  assert.match(photo[0].path, new RegExp(`^${srv.home}/attachments/aiguilleur/[^/]+/photo-\\d+\\.jpg$`))
  assert.equal(readFileSync(photo[0].path, 'utf8'), 'bytes of big.jpg', 'the largest size')
  assert.ok(photo[0].url, 'a thumbnail in the window')
  await message(m => m.text.includes('[Telegram] look') && m.text.includes(photo[0].path), 'the aiguilleur read it with its path')

  say(undefined, { photo: [{ file_id: 'a1' }], media_group_id: 'g' })
  say(undefined, { photo: [{ file_id: 'a2' }], media_group_id: 'g', caption: 'both' })
  assert.deepEqual((await said('both')).files.map(f => readFileSync(f.path, 'utf8')), ['bytes of a1.jpg', 'bytes of a2.jpg'], 'an album: one message')

  say(undefined, { document: { file_id: 'huge', file_name: 'huge.mov', file_size: 30e6 } })
  await message(m => m.text.startsWith('⚠️ huge.mov is too big for a Telegram bot'), 'too big: told so')

  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'see', files: [photo[0].path, '/etc/hosts', join(srv.home, 'state.json')] })
  const got = await waitFor(async () => (await srv.log(w.id)).findLast(e => e.type === 'cg_user' && e.text === 'see'), { what: "the agent's message" })
  assert.equal(got.files.length, 1, 'only the aiguilleur\'s attachments, nothing else on disk')
  assert.ok(got.files[0].path.startsWith(`${srv.home}/attachments/${w.id}/`), 'a copy in its own folder')
  assert.equal(readFileSync(got.files[0].path, 'utf8'), 'bytes of big.jpg')
  await srv.idle(w.id)
})

test("the media an agent shows in its report come to Telegram as files: a photo, a refused one as a document, a missing one said", async () => {
  const { w } = await setup(srv)
  writeFileSync(join(w.path, 'shot.png'), 'PNG')
  writeFileSync(join(w.path, 'thin.png'), 'PNG')
  await srv.turn(w.id, 'see ![the home page](shot.png) ![](thin.png) ![gone](nope.png)')
  const report = await message(m => m.text.endsWith('ok: see 📎 the home page 📎 thin.png 📎 gone'), 'the report, a 📎 for each')
  const card = (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_report' && e.ws === w.id)
  assert.ok(card.text.includes(`![the home page](<${join(w.path, 'shot.png')}>)`), 'absolute in the window and for the aiguilleur')
  const photo = await waitFor(() => calls.find(c => c.method === 'sendPhoto' && c.body.includes('shot.png')), { what: 'the photo' })
  assert.match(photo.body, /name="caption"\r\n\r\nthe home page\r\n/)
  assert.match(photo.body, /\r\n\r\nPNG\r\n/)
  await waitFor(() => calls.find(c => c.method === 'sendDocument' && c.body.includes('thin.png')), { what: 'refused as a photo: sent as a file' })
  await message(m => m.text === '⚠️ nope.png: file not found.', 'the missing one, said')
  assert.ok(sent.indexOf(report) < sent.findIndex(m => m.text.startsWith('⚠️ nope.png')), 'after the text')
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
