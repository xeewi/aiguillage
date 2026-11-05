// Telegram routing (lib/remote.js): who is obeyed, and where each message goes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cgremote-')))
process.env.AIGUILLAGE_HOME = HOME
const { route, journalLines, notesFile, prompt, stale, IDLE, FULL, boardText, activity, md } = await import('../lib/remote.js')
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
  assert.equal(route({ message: { chat: { id: ME } } }, ME, sent), null) // a sticker, a photo…
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

test('the board: counts first (the pinned bar shows them), then who asks, works, failed, rests; durations to the minute', () => {
  const t = (k, v) => i18n.t(k, { lng: 'fr', ...v }), now = 10 * 3600_000
  const text = boardText([
    { label: 'a / idle' },
    { label: 'b / busy', working: true, what: 'Bash: npm test', since: now - 6 * 60_000 },
    { label: 'c / asks', working: true, pending: 'Bash' },
    { label: 'd / long', working: true, since: now - 75 * 60_000 },
    { label: 'e / new', working: true, since: now - 20_000 },
    { label: 'f / broke', failed: true },
  ], { t, now })
  assert.equal(text, [
    '🔐 1 attend · ⏳ 3 en cours · ❌ 1 en erreur · 💤 1 au repos',
    '🔐 c / asks — demande Bash',
    '⏳ b / busy — Bash: npm test · 6 min',
    '⏳ d / long — 1 h 15',
    '⏳ e / new',
    '❌ f / broke',
    '💤 a / idle',
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
