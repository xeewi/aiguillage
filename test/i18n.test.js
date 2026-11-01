// Every locale must translate exactly the keys of en.json, with the same {{placeholders}}.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const load = name => JSON.parse(readFileSync(new URL(`../public/locales/${name}.json`, import.meta.url), 'utf8'))
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]])
const vars = s => [...s.matchAll(/{{(\w+)}}/g)].map(m => m[1]).sort()
const en = Object.fromEntries(flat(load('en')))

for (const code of Object.keys(load('languages')).filter(c => c !== 'en')) {
  test(`locale ${code}: same keys and placeholders as en`, () => {
    const loc = Object.fromEntries(flat(load(code)))
    assert.deepEqual(Object.keys(loc).sort(), Object.keys(en).sort())
    for (const k in en) assert.deepEqual(vars(loc[k]), vars(en[k]), `placeholders of ${k}`)
  })
}

test('server messages: English text plus key and vars for the UI', async () => {
  const { fail, notice } = await import('../lib/i18n.js')
  const e = fail('errors.uncommittedMain', { base: 'main' })
  assert.equal(e.message, 'The main repo (main) has uncommitted changes.')
  assert.deepEqual([e.key, e.vars], ['errors.uncommittedMain', { base: 'main' }])
  assert.deepEqual(notice('messages.committed'), { message: 'Commit created.', key: 'messages.committed', vars: undefined })
})
