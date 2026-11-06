// Telegram routing (lib/remote.js): who is obeyed, and where each message goes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cgremote-')))
process.env.AIGUILLAGE_HOME = HOME
const { route, media, absolute, forTelegram, journalLines, notesFile, prompt, stale, IDLE, FULL, boardText, activity, md, split, dueSlot, urgent, digestText, enqueue } = await import('../lib/remote.js')
const { i18n } = await import('../lib/i18n.js')

const ME = 42
const msg = (text, extra = {}) => ({ message: { message_id: 9, chat: { id: ME }, text, ...extra } })

test('linking: only the one-time code of the Settings link ties a chat; strangers are ignored once linked', () => {
  const u = { message: { chat: { id: 7 }, text: 'hi' } }
  assert.deepEqual(route(u, null, new Map(), 'c0de'), { kind: 'pair', chat: 7 })
  assert.deepEqual(route({ message: { chat: { id: 7 }, text: '/start bad' } }, null, new Map(), 'c0de'), { kind: 'pair', chat: 7 })
  assert.deepEqual(route({ message: { chat: { id: 7, first_name: 'Ada', last_name: 'L' }, text: '/start c0de' } }, null, new Map(), 'c0de'), { kind: 'link', chat: 7, name: 'Ada L' })
  assert.deepEqual(route({ message: { chat: { id: 7 }, text: '/start ' } }, null, new Map(), null), { kind: 'pair', chat: 7 })
  assert.equal(route(u, ME, new Map()), null)
  const q = { callback_query: { id: 'q', data: 'p:ws1:1:req', message: { message_id: 3, chat: { id: 7 } } } }
  assert.equal(route(q, ME, new Map()), null)
  assert.equal(route(q, null, new Map()), null)
})

test('messages: all go to the aiguilleur; a reply to a report says which agent it is about', () => {
  const sent = new Map([[5, 'ws1'], [6, 'aiguilleur']])
  assert.deepEqual(route(msg('fix it', { reply_to_message: { message_id: 5, text: '✅ app / login' } }), ME, sent), { kind: 'send', about: 'ws1', text: 'fix it' })
  assert.deepEqual(route(msg('how are things?'), ME, sent), { kind: 'send', text: 'how are things?' })
  assert.deepEqual(route(msg('and?', { reply_to_message: { message_id: 6, text: 'All idle.' } }), ME, sent), { kind: 'send', text: 'and?' })
  // A report sent before a restart: the aiguilleur gets the quote.
  assert.deepEqual(route(msg('yes', { reply_to_message: { message_id: 1, text: 'Merge?' } }), ME, sent), { kind: 'send', text: '> Merge?\n\nyes' })
  assert.deepEqual(route(msg('/status'), ME, sent), { kind: 'status' })
  assert.deepEqual(route(msg('/remote'), ME, sent), { kind: 'remote' })
  assert.deepEqual(route(msg('/local@aig_bot'), ME, sent), { kind: 'local' })
  assert.deepEqual(route(msg('/stop', { reply_to_message: { message_id: 5 } }), ME, sent), { kind: 'stop', ws: 'ws1' })
  assert.deepEqual(route(msg('/stop'), ME, sent), { kind: 'stop', ws: 'aiguilleur' })
  assert.equal(route({ message: { chat: { id: ME } } }, ME, sent), null) // a sticker, a location…
})

test('media: the file a message carries goes to the aiguilleur, its caption as the text; an album is marked to gather', () => {
  const sent = new Map([[5, 'ws1']])
  const photo = [{ file_id: 's', file_size: 10 }, { file_id: 'L', file_size: 900 }]
  assert.deepEqual(route(msg(undefined, { photo, caption: ' look ' }), ME, sent), { kind: 'send', text: 'look', files: [{ id: 'L', name: 'photo-9.jpg', size: 900 }] })
  assert.deepEqual(route(msg(undefined, { document: { file_id: 'd', file_name: 'spec.pdf', mime_type: 'application/pdf' }, reply_to_message: { message_id: 5 } }), ME, sent),
    { kind: 'send', about: 'ws1', text: '', files: [{ id: 'd', name: 'spec.pdf', size: undefined }] })
  assert.deepEqual(route(msg(undefined, { photo, media_group_id: 'g1' }), ME, sent).album, 'g1')
  assert.deepEqual(route(msg(undefined, { photo, caption: '/status' }), ME, sent).kind, 'send', 'a caption is never a command')
  assert.equal(media({ message_id: 3, voice: { file_id: 'v', mime_type: 'audio/ogg' } }).name, 'voice-3.ogg')
  assert.equal(media({ message_id: 3, video_note: { file_id: 'n' } }).name, 'video_note-3.mp4')
  assert.equal(media({ message_id: 3, sticker: { file_id: 'k' } }), null)
})

test("media shown: an agent's paths made absolute in its report; on Telegram, a 📎 caption in the text and the files after it", () => {
  const text = 'Done: ![home page](shots/home.png), [demo](</tmp/a b.mp4>), [docs](https://x.dev/a.png), ![](~/s.gif) and [notes](notes.md)'
  assert.equal(absolute(text, '/wt'), 'Done: ![home page](</wt/shots/home.png>), [demo](</tmp/a b.mp4>), [docs](https://x.dev/a.png), ![](<~/s.gif>) and [notes](notes.md)')
  const s = forTelegram(absolute(text, '/wt'), '/aig')
  assert.equal(s.text, 'Done: 📎 home page, 📎 demo, [docs](https://x.dev/a.png), 📎 s.gif and [notes](notes.md)')
  assert.deepEqual(s.files.map(f => [f.path.replace(process.env.HOME, '~'), f.caption]), [['/wt/shots/home.png', 'home page'], ['/tmp/a b.mp4', 'demo'], ['~/s.gif', '']])
  assert.deepEqual(forTelegram('![x](out%20dir/x.png)', '/aig').files, [{ path: '/aig/out dir/x.png', caption: 'x' }], "the aiguilleur's own paths, from its folder")
})

test('buttons: Allow / Deny of a permission request', () => {
  const q = { callback_query: { id: 'q', data: 'p:ws1:0:toolu:1', message: { message_id: 3, chat: { id: ME } } } }
  assert.deepEqual(route(q, ME, new Map()), { kind: 'perm', ws: 'ws1', allow: false, id: 'toolu:1', query: 'q', msg: 3 })
})

test('journal: bullets cleaned and capped, NOTHING means nothing; one notes file per repo name', () => {
  assert.deepEqual(journalLines('NOTHING'), [])
  assert.deepEqual(journalLines('Nothing worth keeping.'), [])
  assert.deepEqual(journalLines('- Login fixed\n* Tests: npm test\n\n1. PR open'), ['Login fixed', 'Tests: npm test', 'PR open'])
  assert.equal(journalLines('a\nb\nc\nd\ne\nf').length, 5)
  assert.equal(notesFile('/c', { name: 'my app/v2' }), '/c/projects/my-app-v2.md')
})

test("prompt: the reports since the user's last message head it, then where the message comes from", () => {
  const report = (ws, text, ok = true) => ({ type: 'cg_report', ws, label: `app / ${ws}`, ok, text })
  assert.equal(prompt('hi', {}, []), 'hi')
  assert.equal(prompt('hi', { via: 'telegram' }, [report('old', 'seen'), { type: 'cg_user', text: 'x' }]), '[Telegram] hi')
  const p = prompt('go on', {}, [report('a', 'seen'), { type: 'cg_user', text: 'x' }, report('b', 'Done.'), report('c', 'Broke', false)])
  assert.equal(p, '[Reports from the agents since your last message]\n\n✅ app / b\n\nDone.\n(workspace id b)\n\n❌ app / c\n\nBroke\n(workspace id c)\n\n---\n\ngo on')
  const many = Array.from({ length: 32 }, (_, i) => report('w' + i, 'x'.repeat(3000)))
  const q = prompt('?', {}, many)
  assert.match(q, /\(2 older ones left out/)
  assert.ok(!q.includes('w1\n') && q.includes('(workspace id w31)') && q.includes('x'.repeat(2000) + '…') && !q.includes('x'.repeat(2001)))
})

test('the aiguilleur starts afresh after an hour without a message or past FULL tokens, not after a clear', () => {
  const now = 10 * IDLE, u = ts => ({ type: 'cg_user', ts })
  assert.equal(stale([], null, now), false)
  assert.equal(stale([u(now - 60_000)], { used: 50_000 }, now), false)
  assert.equal(stale([u(now - IDLE - 1)], { used: 50_000 }, now), true)
  assert.equal(stale([u(now - 60_000)], { used: FULL + 1 }, now), true)
  assert.equal(stale([u(now - IDLE - 1), { type: 'cg_report', ts: now }], null, now), true) // reports don't keep it warm
  assert.equal(stale([u(now - IDLE - 1), { type: 'cg_clear', ts: now - IDLE }], { used: FULL + 1 }, now), false)
})

test('the board: counts first (the pinned bar shows them), the plan usage, then each repo once, short titles, the resting ones on one line', () => {
  const t = (k, v) => i18n.t(k, { lng: 'fr', ...v }), now = 10 * 3600_000
  const usage = { limits: [{ kind: 'weekly_all', pct: 42, resetsAt: now + 3 * 86400_000 }, { kind: 'session', pct: 93, resetsAt: now + 130 * 60_000 }, { kind: 'weekly_opus', pct: 5 }] }
  const text = boardText([
    { repo: 'a', title: 'idle' },
    { repo: 'b', title: 'busy', working: true, what: 'Bash: npm test', since: now - 6 * 60_000 },
    { repo: 'c', title: 'asks', working: true, pending: 'Bash' },
    { repo: 'b', title: 'long', working: true, since: now - 75 * 60_000 },
    { repo: 'b', title: 'new', working: true, since: now - 20_000 },
    { repo: 'a', title: 'broke', failed: true },
    { repo: 'a', title: 'Plugin Tamagotchi façon Jota Magotchi' },
  ], { t, now, usage, lang: 'fr' })
  assert.equal(text, [
    '🔐 1 attend · ⏳ 3 en cours · ❌ 1 en erreur · 💤 2 au repos',
    '🔴 Session 93 % · reset dans 2 h 10',
    `📊 Semaine 42 % · reset ${new Intl.DateTimeFormat('fr', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(now + 3 * 86400_000)}`,
    '', '▸ c', '🔐 asks — demande Bash',
    '', '▸ b', '⏳ busy — Bash: npm test · 6 min', '⏳ long — 1 h 15', '⏳ new',
    '', '▸ a', '❌ broke', '💤 idle · Plugin Tamagotchi façon Jota…',
  ].join('\n'))
  assert.equal(boardText([], { t: (k, v) => i18n.t(k, v), paused: true }), "No active workspace.\n\n⏸ Remote mode off: this board no longer updates. /remote to turn it back on.")
})

test("what a tool call is doing, in a few words; our own text escaped inside Markdown", () => {
  assert.equal(activity({ name: 'Bash', input: { command: 'npm test\nmore', description: 'Run the tests' } }), 'Bash: Run the tests')
  assert.equal(activity({ name: 'Edit', input: { file_path: '/x/lib/remote.js' } }), 'Edit: remote.js')
  assert.equal(activity({ name: 'Bash', input: { command: 'x'.repeat(80) } }), `Bash: ${'x'.repeat(49)}…`)
  assert.equal(activity({ name: 'TodoWrite', input: { todos: [] } }), 'TodoWrite')
  assert.equal(md('my_repo / *wip* [1] `x` #2'), 'my\\_repo / \\*wip\\* \\[1\\] \\`x\\` \\#2')
})

test('a long text: parts under the limit, cut between lines, nothing lost; a code block cut in two closed and reopened', () => {
  assert.deepEqual(split('short', 100), ['short'])
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const parts = split(text, 100)
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 100))
  assert.equal(parts.join('\n'), text, 'cut between lines')
  const long = split('x'.repeat(250), 100)
  assert.ok(long.every(p => p.length <= 100) && long.join('') === 'x'.repeat(250), 'a line too long is cut too')
  const code = ['intro', '```js', ...Array.from({ length: 30 }, (_, i) => `f(${i})`), '```', 'outro'].join('\n')
  const cut = split(code, 100)
  assert.ok(cut.length > 1 && cut.every(p => p.length <= 100))
  assert.ok(cut.every(p => (p.match(/^```/gm) ?? []).length % 2 === 0), 'each part has its code blocks closed')
  assert.ok(cut.slice(1, -1).every(p => p.startsWith('```js\n')), 'reopened with its language')
  assert.equal(cut.join('\n').replace(/\n```\n```js/g, ''), code, 'nothing else added')
})

test('prompt(): a long report is cut in its body, never in its block', () => {
  const block = '```aig-report\nstatus: blocked\nchecks: none\nunverified: all\nneeds: the API key\n```'
  const p = prompt('?', {}, [{ type: 'cg_report', ws: 'w', label: 'A / b', ok: true, status: 'blocked', text: 'x'.repeat(5000) + '\n\n' + block }])
  assert.ok(p.includes(block + '\n(workspace id w)') && p.startsWith('[Reports') && p.includes('⏸ A / b'))
  assert.ok(p.length < 2500)
})

test('dueSlot: a slot passed since the last digest', () => {
  const at = h => new Date(2026, 10, 20, h, 5).getTime()
  assert.equal(dueSlot(at(8), at(9)), true)
  assert.equal(dueSlot(at(9), at(12)), false)
  assert.equal(dueSlot(at(9), at(13)), true)
  assert.equal(dueSlot(at(18), new Date(2026, 10, 21, 8).getTime()), false)
  assert.equal(dueSlot(at(18), new Date(2026, 10, 21, 9, 1).getTime()), true, 'the next morning')
})

test('urgent: failed, waiting, red check, touched tests, overlap, stall, a confirmed action; a plain done is not', () => {
  const ok = { ok: true, status: null }
  assert.equal(urgent(ok), false)
  assert.equal(urgent({ ...ok, check: { ok: true } }), false)
  for (const x of [{ ok: false }, { status: 'blocked' }, { status: 'decision' }, { check: { ok: false } }, { testsTouched: ['a.test.js'] }, { overlap: ['a.js'] }, { stall: 'no output for 20 min' }, { action: true }])
    assert.equal(urgent({ ...ok, ...x }), true, JSON.stringify(x))
})

test('digestText: one line per report, cut at 120 characters', () => {
  const t = (k, v) => `${k}:${v.count}`
  const text = digestText([{ ws: 'a', md: `**✅ app / login**\n\nFirst line\nsecond line` }, { ws: 'b', md: `**✅ app / long**\n\n${'x'.repeat(300)}` }], t)
  const [title, a, b] = text.split('\n\n')
  assert.equal(title, '**telegram.digestTitle:2**')
  assert.equal(a, '**✅ app / login** First line')
  assert.equal(b, `**✅ app / long** ${'x'.repeat(120)}`)
})

test('enqueue: the digest window starts with the first waiting report, not at the last digest', () => {
  const at = h => new Date(2026, 10, 20, h, 5).getTime()
  const g = { queue: [], digestAt: at(9) }
  enqueue(g, { ws: 'a', md: 'x' }, at(14))
  assert.equal(dueSlot(g.digestAt, at(14) + 60_000), false, 'not due at 14:06, the 13:00 slot is before the report')
  assert.equal(dueSlot(g.digestAt, at(18)), true)
  enqueue(g, { ws: 'b', md: 'y' }, at(15))
  assert.equal(g.digestAt, at(14), 'a second report does not move it')
})

test('digestText: images dropped, Markdown of the text escaped', () => {
  const [, line] = digestText([{ ws: 'a', md: '**✅ app / x**\n\n![shot](/tmp/a.png) did *it* `now`' }], () => 'T').split('\n\n')
  assert.equal(line, '**✅ app / x** did \\*it\\* \\`now\\`')
})
