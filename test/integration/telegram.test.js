// Telegram bridge end to end, against a fake Bot API: the aiguilleur as the one interlocutor (turn reports, replies,
// one conversation in the window and on Telegram), permission buttons, the pinned board, Markdown rendered by Telegram.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, waitFor, sleep, git } from '../helpers.mjs'

const ME = 42
const updates = [], sent = [], calls = []
let failSends = false
const failed = []
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
  if (failSends && (method === 'sendMessage' || method === 'sendRichMessage')) { failed.push(b); res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, description: 'boom' })) }
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
  await srv.api('PATCH', '/telegram', { digest: 'off' }) // the tests below expect every report at once; the digest ones switch it on
  const board = await message(m => m.text.startsWith('No active workspace.') && m.disable_notification, 'the board')
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

test('a confirmation comes to Telegram with buttons; Allow there runs it', async () => {
  const { repoPath, w } = await setup(srv)
  writeFileSync(join(w.path, 'tg.txt'), 'tg\n')
  await srv.api('POST', `/workspaces/${w.id}/commit`, { message: 'tg' })
  const { pending } = await srv.asAiguilleur('POST', `/workspaces/${w.id}/merge`)
  const ask = await message(m => m.reply_markup && m.text.includes(`Merge ${w.branch} into main`), 'the confirmation, with its buttons')
  assert.match(ask.text, /The aiguilleur asks to:/)
  const [allow] = ask.reply_markup.inline_keyboard[0]
  assert.equal(allow.callback_data, `p:aiguilleur:1:${pending}`)
  push({ callback_query: { id: 'cb-confirm', data: allow.callback_data, from: {}, message: { message_id: ask.message_id, chat: { id: ME } } } })
  await waitFor(() => existsSync(join(repoPath, 'tg.txt')), { what: 'merged after Allow on Telegram' })
  await message(m => m.text.startsWith('**✅ ') && m.text.includes('Merged into main'), 'the outcome, reported')
})

test('Allow on a request that no longer exists (dropped by a restart) says so instead of ✅', async () => {
  push({ callback_query: { id: 'cb-gone', data: 'p:aiguilleur:1:gone', from: {}, message: { message_id: 1, chat: { id: ME } } } })
  const a = await waitFor(() => calls.find(c => c.method === 'answerCallbackQuery' && c.callback_query_id === 'cb-gone'), { what: 'the answer' })
  assert.equal(a.text, 'No longer pending.')
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
  await waitFor(() => edits().some(c => /^[^\n]*⏳ 1 working/.test(c.text) && c.text.includes(`\n▸ ${repo.name}\n`) && c.text.includes('\n⏳ ') && c.text.includes('\n📊 Session 42 % · ') && c.text.includes('\n🔴 Week 93 % · ')), { what: 'shown working under its repo, counted in the first line, with the plan usage' })
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

test("the files an agent shows in its report come to Telegram: a photo, a refused one as a document, a .ics as a document, a missing one said", async () => {
  const { w } = await setup(srv)
  writeFileSync(join(w.path, 'shot.png'), 'PNG')
  writeFileSync(join(w.path, 'thin.png'), 'PNG')
  writeFileSync(join(w.path, 'r.ics'), 'BEGIN:VCALENDAR')
  await srv.turn(w.id, 'see ![the home page](shot.png) ![](thin.png) ![gone](nope.png) ![reminder](r.ics)')
  const report = await message(m => m.text.endsWith('ok: see 📎 the home page 📎 thin.png 📎 gone 📎 reminder'), 'the report, a 📎 for each')
  const card = (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_report' && e.ws === w.id)
  assert.ok(card.text.includes(`![the home page](<${join(w.path, 'shot.png')}>)`), 'absolute in the window and for the aiguilleur')
  const photo = await waitFor(() => calls.find(c => c.method === 'sendPhoto' && c.body.includes('shot.png')), { what: 'the photo' })
  assert.match(photo.body, /name="caption"\r\n\r\nthe home page\r\n/)
  assert.match(photo.body, /\r\n\r\nPNG\r\n/)
  await waitFor(() => calls.find(c => c.method === 'sendDocument' && c.body.includes('thin.png')), { what: 'refused as a photo: sent as a file' })
  const ics = await waitFor(() => calls.find(c => c.method === 'sendDocument' && c.body.includes('r.ics')), { what: 'any other file embedded: an attached file' })
  assert.match(ics.body, /\r\n\r\nBEGIN:VCALENDAR\r\n/)
  await message(m => m.text === '⚠️ nope.png: file not found.', 'the missing one, said')
  assert.ok(sent.indexOf(report) < sent.findIndex(m => m.text.startsWith('⚠️ nope.png')), 'after the text')
})

test('a long text goes whole, in several messages: rich ones, or plain ones of 4096 characters at most', async () => {
  const { w } = await setup(srv)
  const words = Array.from({ length: 3000 }, (_, i) => `line ${i} of a long answer`).join('\n')
  for (const [ask, method, max] of [['LONG', 'sendRichMessage', 16_000], ['UNPARSABLE', 'sendMessage', 4096]]) {
    const before = sent.length
    await srv.turn(w.id, `${ask}\n${words}`)
    await message(m => sent.indexOf(m) >= before && m.text.endsWith('line 2999 of a long answer'), `the end of the ${ask} report`)
    const parts = sent.slice(before).filter(m => m.method === method)
    assert.ok(parts.length > 1 && parts.every(m => m.text.length <= max), `${ask}: several messages, each under the limit`)
    // Only the part with UNPARSABLE is refused: it goes plain, the next ones still rich.
    assert.ok(sent.slice(before).map(m => m.text).join('\n').endsWith(`ok: ${ask}\n${words}`), `${ask}: nothing lost`)
  }
})

test('a turn ending with a report block: its status is kept, ⏸ when it waits on the user', async () => {
  const { repo, w } = await setup(srv)
  await srv.turn(w.id, 'report decision Which DB?')
  const rep = await waitFor(async () => (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_report' && e.ws === w.id), { what: 'the report' })
  assert.deepEqual([rep.status, rep.ok], ['decision', true])
  await message(m => m.text.startsWith(`**⏸ ${repo.name} / `) && m.text.includes('Which DB?'), 'the report, marked ⏸')
})

test('a turn without a block still reports, ✅ as before', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'hello')
  const rep = await waitFor(async () => (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_report' && e.ws === w.id), { what: 'the report' })
  assert.deepEqual([rep.status, rep.ok, rep.text], [null, true, 'ok: hello'])
})

test('a crash still reports ❌', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'crash' })
  const rep = await waitFor(async () => (await srv.log('aiguilleur')).findLast(e => e.type === 'cg_report' && e.ws === w.id), { what: 'the crash report' })
  assert.deepEqual([rep.status, rep.ok, rep.key, rep.vars.code], [null, false, 'chat.agentExited', 3], "Aiguillage's words: translated when shown")
})

const lastReport = w => srv.log('aiguilleur').then(l => l.findLast(e => e.type === 'cg_report' && e.ws === w.id))

test('a turn the user stopped reports ⏹ Stopped, not ❌', async () => {
  const { repo, w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'slow' })
  await waitFor(async () => (await srv.ws(w.id)).busy, { what: 'working' })
  await sleep(300) // the fake is streaming: the interrupt lands inside the turn
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
  const rep = await waitFor(() => lastReport(w), { what: 'the report' })
  assert.deepEqual([rep.ok, rep.interrupted, rep.key], [true, true, 'report.interrupted'])
  await message(m => m.text.startsWith(`**⏹ ${repo.name} / `) && m.text.includes('\n\nStopped'), 'the report, marked ⏹')
})

test("a stop that had to be forced doesn't make the next turn's error a ⏹: it is ❌", async () => {
  const { repo, w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'deaf 15000' })
  await waitFor(async () => (await srv.ws(w.id)).busy, { what: 'working' })
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
  await srv.idle(w.id, 10_000) // the CLI ignored it: stopped after 5 s
  await srv.turn(w.id, 'fail overloaded')
  const rep = await waitFor(async () => { const r = await lastReport(w); return r?.text === 'overloaded' && r }, { what: "the failed turn's report" })
  assert.deepEqual([rep.ok, rep.interrupted], [false, undefined])
  await message(m => m.text.startsWith(`**❌ ${repo.name} / `) && m.text.endsWith('overloaded'), 'the report, ❌')
})

test("an aiguilleur's turn the user stopped reads ⏹ Stopped on Telegram, not ❌", async () => {
  await srv.turn('aiguilleur', 'flush') // its unread reports would head the next message
  await srv.api('POST', '/workspaces/aiguilleur/send', { text: 'slow' })
  await waitFor(async () => (await srv.state()).aiguilleur.busy, { what: 'working' })
  await sleep(300) // the fake is streaming: the interrupt lands inside the turn
  await srv.api('POST', '/workspaces/aiguilleur/interrupt')
  await message(m => m.text.startsWith('⏹ Stopped\n\ntick 0'), 'its answer, marked ⏹')
})

test('a brief to confirm reads in the chat\'s language on Telegram: its heading and overlap warning; the brief as the agent reads it', async () => {
  const { repo, w } = await setup(srv)
  const w2 = await srv.api('POST', '/workspaces', { repoId: repo.id })
  await srv.turnScanned(w.id, 'write src/auth.js x') // the warning reads the scan's lists
  let before = sent.length
  say('/status', { from: { language_code: 'fr' } })
  try {
    await message(m => sent.indexOf(m) >= before && m.disable_notification, 'a board, the chat now in French')
    const { pending } = await srv.asAiguilleur('POST', `/workspaces/${w2.id}/brief`, { goal: 'Fix login', scope: ['src'] })
    const ask = await message(m => m.reply_markup && m.text.includes('Goal: Fix login'), 'the confirmation')
    assert.match(ask.text, /Brief pour [^\n]+ :\nCe que l'agent lira :\nTask brief\nGoal: Fix login\nScope \(the files[^\n]*\n⚠️ chevauche [^\n]+ : src\/auth\.js/)
    await srv.api('POST', '/workspaces/aiguilleur/permission', { id: pending, allow: false })
  } finally { // the next tests read English
    before = sent.length
    say('/status')
    await message(m => sent.indexOf(m) >= before && m.disable_notification, 'back in English')
  }
})

test('a long brief to confirm goes to Telegram in several messages, each with its code block closed', async () => {
  const { w } = await setup(srv)
  const long = (s, n = 299) => (s + 'y'.repeat(n)).slice(0, n)
  // UNPARSABLE: Telegram refuses it rich, so it goes plain, 4096 characters a message.
  const brief = { goal: long('UNPARSABLE goal ', 500), scope: Array.from({ length: 20 }, (_, i) => long(`src/m${i}/`)), escalate: long('new deps '),
    done: ['```js', ...Array.from({ length: 18 }, (_, i) => long(`check ${i} `)), '```'] }
  const before = sent.length
  const { pending } = await srv.asAiguilleur('POST', `/workspaces/${w.id}/brief`, brief)
  const last = await message(m => sent.indexOf(m) >= before && m.reply_markup?.inline_keyboard[0][0].callback_data.endsWith(pending), 'the confirmation, its buttons under the last part')
  const parts = sent.slice(before, sent.indexOf(last) + 1).filter(m => m.method === 'sendMessage' && !m.disable_notification)
  assert.ok(parts.map(m => m.text).join('').length >= 12_000)
  assert.ok(parts.length > 1 && parts.every(m => m.text.length <= 4096), 'several plain messages')
  assert.ok(parts.every(m => (m.text.match(/^```/gm) ?? []).length % 2 === 0), 'each one with its code block closed')
  await srv.api('POST', '/workspaces/aiguilleur/permission', { id: pending, allow: false })
})

test('the board shows 🧪❌ while the check is red on these files, and no longer once the repo has no check', async () => {
  const { repoPath, w } = await setup(srv, { '.aiguillage/settings.toml': '[scripts]\ncheck = "test -f ok.txt"\n' })
  const board = () => calls.filter(c => c.method === 'editMessageText' || (c.method === 'sendMessage' && c.disable_notification)).at(-1)?.text ?? ''
  await srv.turn(w.id, 'write other.txt x')
  await waitFor(() => board().includes('🧪❌'), { what: 'the red check on the board' })
  rmSync(join(repoPath, '.aiguillage/settings.toml'))
  await srv.turn(w.id, 'write more.txt y')
  await waitFor(async () => (await lastReport(w)).text.includes('more.txt') && !board().includes('🧪❌'), { what: 'gone with the check' })
})

test('remote mode off: every urgent report waits for the catch-up, with the latest other one, in order', async () => {
  const { w } = await setup(srv)
  let before = sent.length
  await srv.api('PATCH', '/telegram', { remote: false })
  await message(m => sent.indexOf(m) >= before && m.text.startsWith('Remote mode off'), 'off')
  for (const text of ['report blocked first one', 'hello early', 'report decision second one', 'hello third']) await srv.turn(w.id, text)
  await waitFor(async () => (await srv.log('aiguilleur')).filter(e => e.type === 'cg_report' && e.ws === w.id).length === 4, { what: 'four reports' })
  before = sent.length
  await srv.api('PATCH', '/telegram', { remote: true })
  // The body, not the title (the workspace is named after its first message).
  const got = sent.slice(before).map(m => m.text.split('\n\n')[1]?.match(/first one|second one|hello early|hello third/)?.[0]).filter(Boolean)
  assert.deepEqual(got, ['first one', 'second one', 'hello third'])
})

test("remote mode off: a report on a workspace archived meanwhile still comes with the catch-up", async () => {
  const { w: a, repo } = await setup(srv)
  const b = await srv.api('POST', '/workspaces', { repoId: repo.id })
  await srv.api('PATCH', '/telegram', { remote: false })
  await srv.api('PATCH', '/defaults', { maxAgents: 1 })
  try {
    await srv.api('POST', `/workspaces/${a.id}/send`, { text: 'hang 1200' })
    await waitFor(async () => (await srv.ws(a.id)).busy, { what: 'a working' })
    await srv.api('POST', `/workspaces/${b.id}/send`, { text: 'never sent', queue: true })
    await srv.api('POST', `/workspaces/${b.id}/archive`)
    await waitFor(async () => (await srv.log('aiguilleur')).some(e => e.type === 'cg_report' && e.ws === b.id && e.key === 'queue.dropped'), { what: 'the dropped report' })
  } finally { await srv.api('PATCH', '/defaults', { maxAgents: 5 }) }
  // a's own report in first: it must not land in a later test's digest.
  await waitFor(async () => (await srv.log('aiguilleur')).some(e => e.type === 'cg_report' && e.ws === a.id), { what: "a's report" })
  const before = sent.length
  await srv.api('PATCH', '/telegram', { remote: true })
  assert.ok(sent.slice(before).some(m => m.text.includes('dropped without being sent') && m.text.includes('never sent')), 'the archived workspace\'s report, caught up')
})

test('batched: a done report waits, a blocked one is pushed at once', async () => {
  await srv.api('PATCH', '/telegram', { digest: 'batched' })
  assert.equal((await srv.state()).telegram.digest, 'batched')
  const a = await setup(srv), b = await setup(srv)
  await srv.turn(a.w.id, 'quiet work')
  await waitFor(() => lastReport(a.w), { what: 'the done report' })
  await srv.turn(b.w.id, 'report blocked Need the API key')
  await message(m => m.text.includes('Need the API key'), 'the blocked report, at once')
  assert.ok(!sent.some(m => m.text.includes('quiet work')), 'the done one waits')
})

test('/digest sends the waiting reports in one message', async () => {
  say('/digest')
  const d = await message(m => m.text.startsWith('**') && m.text.match(/reports? since the last digest/), 'the digest')
  assert.match(d.text, /^\*\*\d+ reports? since the last digest\*\*\n\n\*\*✅ .+\*\* ok: quiet work/)
  say('/digest')
  await message(m => m.text === 'No report waiting.', 'nothing left')
})

test('a digest that fails to send keeps its reports', async () => {
  await srv.api('PATCH', '/telegram', { digest: 'batched' })
  const { w } = await setup(srv)
  await srv.turn(w.id, 'keep me')
  const queued = () => JSON.parse(readFileSync(join(srv.home, 'state.json'), 'utf8')).telegram.queue?.length
  await waitFor(queued, { what: 'queued' })
  failSends = true
  say('/digest')
  // The rich attempt fails, then its plain fallback: only then may sends work again.
  await waitFor(() => failed.some(b => b.text?.includes('keep me')), { what: 'the failed plain send' })
  failSends = false
  assert.ok(queued() >= 1, 'still waiting')
  say('/digest')
  await message(m => m.text.match(/reports? since the last digest/) && m.text.includes('keep me'), 'sent on the next try')
})

test('the waiting reports survive a restart', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'before the restart')
  await waitFor(async () => (await lastReport(w)) && JSON.parse(readFileSync(join(srv.home, 'state.json'), 'utf8')).telegram.queue?.length, { what: 'queued and saved' })
  const { home } = srv
  await srv.stop()
  srv = await startServer({ home, env: { AIGUILLAGE_TELEGRAM_API: `http://127.0.0.1:${tg.address().port}` } })
  say('/digest')
  await message(m => m.text.match(/reports? since the last digest/) && m.text.includes('before the restart'), 'the digest, after the restart')
})

test('a digest whose slot passed while remote mode was off goes with the catch-up', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'waited for its slot')
  const file = join(srv.home, 'state.json'), saved = () => JSON.parse(readFileSync(file, 'utf8'))
  await waitFor(() => saved().telegram.queue?.some(q => q.md.includes('waited for its slot')), { what: 'queued' })
  await srv.api('PATCH', '/telegram', { remote: false })
  const { home } = srv
  await srv.stop()
  const s = saved(); s.telegram.digestAt = Date.now() - 2 * 86400_000; writeFileSync(file, JSON.stringify(s)) // a slot went by meanwhile
  srv = await startServer({ home, env: { AIGUILLAGE_TELEGRAM_API: `http://127.0.0.1:${tg.address().port}` } })
  const before = sent.length
  await srv.api('PATCH', '/telegram', { remote: true })
  assert.ok(sent.slice(before).some(m => /reports? since the last digest/.test(m.text) && m.text.includes('waited for its slot')), 'the digest, with the catch-up')
})

test('digest off: every report pushed as before', async () => {
  await srv.api('PATCH', '/telegram', { digest: 'off' })
  const { w } = await setup(srv)
  await srv.turn(w.id, 'pushed now')
  await message(m => m.text.endsWith('ok: pushed now'), 'the report, at once')
})

test('remote mode off: what the aiguilleur asks to do in a turn from Telegram still gets its buttons there', async () => {
  const { w } = await setup(srv)
  writeFileSync(join(w.path, 'tg.txt'), 'x\n'); git(w.path, 'add', '-A'); git(w.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tg')
  await srv.api('PATCH', '/telegram', { remote: false })
  try {
    const before = sent.length // names repeat across repos: only what this test makes
    say(`bash curl -s -X POST -H "authorization: Bearer $AIGUILLAGE_TOKEN" -H 'content-type: application/json' http://127.0.0.1:${srv.port}/api/workspaces/${w.id}/merge`)
    const ask = await waitFor(() => sent.slice(before).find(m => m.reply_markup && m.text.includes(`Merge aig/${w.name} into main`)), { what: 'the buttons, out of remote mode' })
    const [allow] = ask.reply_markup.inline_keyboard[0]
    push({ callback_query: { id: 'cbm', data: allow.callback_data, from: {}, message: { message_id: ask.message_id, chat: { id: ME } } } })
    await waitFor(async () => (await srv.log('aiguilleur')).some(e => e.type === 'cg_report' && e.ws === w.id && e.key === 'messages.merged'), { what: 'merged on the click' })
    // Its outcome too, still out of remote mode (not held for a catch-up).
    await waitFor(() => sent.slice(before).find(m => m.text.startsWith('**✅ ') && m.text.includes(`Merged into main`)), { what: 'the outcome on Telegram, out of remote mode' })
  } finally { await srv.api('PATCH', '/telegram', { remote: true }) }
})

test('a new token keeps the digest choice', async () => {
  await srv.api('PATCH', '/telegram', { digest: 'off' })
  await srv.api('POST', '/telegram', { token: '2:y' })
  const { telegram } = await srv.state()
  assert.deepEqual([telegram.on, telegram.linked, telegram.digest], [true, false, 'off'])
})

test('Disconnect stops the bot', async () => {
  await srv.api('POST', '/telegram', { token: '' })
  assert.deepEqual((await srv.state()).telegram, { on: false, linked: false, remote: false, digest: 'off' })
})

test("a finished turn adds what's worth keeping to the project's journal, in the aiguilleur's folder", async () => {
  const { repo, w } = await setup(srv)
  await srv.turn(w.id, 'note this')
  const file = join(srv.home, 'aiguilleur', 'projects', repo.name + '.md')
  const { name } = await srv.ws(w.id)
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes(`(${name}): `), { what: 'journal line' })
  assert.match(readFileSync(file, 'utf8'), /^# repo\n\nPath: .*\n\n## Journal\n- \d{4}-\d\d-\d\d \(/)
})

test('a turn that changes test files says so in its report; one that does not, nothing', async () => {
  const { w } = await setup(srv, { 'src/a.js': 'a', 'test/a.test.js': 'a' })
  const lastReport = () => srv.log('aiguilleur').then(l => l.findLast(e => e.type === 'cg_report' && e.ws === w.id))
  await srv.turn(w.id, 'write test/x.test.js broken')
  const rep = await waitFor(lastReport, { what: 'the report' })
  assert.deepEqual(rep.testsTouched, ['test/x.test.js'])
  await srv.turn(w.id, 'write src/y.js ok')
  await waitFor(async () => (await lastReport()).text.includes('y.js') && (await lastReport()), { what: 'the second report' })
  assert.equal('testsTouched' in await lastReport(), false)
})
