// Telegram routing (lib/remote.js): who is obeyed, and where each message goes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cgremote-')))
process.env.AIGUILLAGE_HOME = HOME
const { route, settings, journalLines, notesFile } = await import('../lib/remote.js')

const ME = 42
const msg = (text, extra = {}) => ({ message: { message_id: 9, chat: { id: ME }, text, ...extra } })

test('settings: off without a token, chat optional until paired', () => {
  assert.equal(settings(HOME), null)
  writeFileSync(join(HOME, 'settings.toml'), '[telegram]\ntoken = "1:abc"\n')
  assert.deepEqual(settings(HOME), { token: '1:abc', chat: null })
  writeFileSync(join(HOME, 'settings.toml'), '[telegram]\ntoken = "1:abc"\nchat = 42\n')
  assert.deepEqual(settings(HOME), { token: '1:abc', chat: 42 })
})

test('strangers: told their id only while unpaired, ignored after', () => {
  const u = { message: { chat: { id: 7 }, text: 'hi' } }
  assert.deepEqual(route(u, null, new Map()), { kind: 'pair', chat: 7 })
  assert.equal(route(u, ME, new Map()), null)
  const q = { callback_query: { id: 'q', data: 'p:ws1:1:req', message: { message_id: 3, chat: { id: 7 } } } }
  assert.equal(route(q, ME, new Map()), null)
  assert.equal(route(q, null, new Map()), null)
})

test('messages: replies go to the agent reported on, the rest to the aiguilleur', () => {
  const sent = new Map([[5, 'ws1']])
  assert.deepEqual(route(msg('fix it', { reply_to_message: { message_id: 5, text: '✅ app / login' } }), ME, sent), { kind: 'send', ws: 'ws1', text: 'fix it' })
  assert.deepEqual(route(msg('how are things?'), ME, sent), { kind: 'send', ws: 'aiguilleur', text: 'how are things?' })
  // A report sent before a restart: the aiguilleur gets the quote.
  assert.deepEqual(route(msg('yes', { reply_to_message: { message_id: 1, text: 'Merge?' } }), ME, sent), { kind: 'send', ws: 'aiguilleur', text: '> Merge?\n\nyes' })
  assert.deepEqual(route(msg('/status'), ME, sent), { kind: 'status' })
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
