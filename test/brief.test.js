import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validBrief, briefText } from '../lib/brief.js'

test('briefText: the exact copy for a full brief', () => {
  const b = validBrief({ goal: ' Fix login ', scope: ['src/auth.js', 'src/login.js'], done: ['tests pass', 'no console error'], escalate: 'a schema change' })
  assert.equal(briefText(b), [
    'Task brief', 'Goal: Fix login', 'Scope (the files or modules you may change): src/auth.js, src/login.js',
    'Done when (check each one before reporting done):', '- tests pass', '- no console error', 'Escalate to the user before: a schema change'].join('\n'))
})
test('briefText leaves empty fields out', () => {
  assert.equal(briefText(validBrief({ goal: 'g' })), 'Task brief\nGoal: g')
})
test('validBrief refuses an empty goal, too many or empty criteria', () => {
  for (const body of [{ goal: '' }, {}, { goal: 'g', done: Array(21).fill('x') }, { goal: 'g', scope: [' '] }, { goal: 'g', done: 'x' }, { goal: 'x'.repeat(501) }])
    assert.throws(() => validBrief(body), e => e.key === 'errors.badBrief')
})
test('validBrief refuses non-string entries, a non-string escalate, an escalate over 300 characters', () => {
  for (const body of [{ goal: 'g', scope: [1] }, { goal: 'g', done: [{ x: 1 }] }, { goal: 'g', scope: ['a', null] }, { goal: 'g', escalate: 3 }, { goal: 'g', escalate: ['x'] }, { goal: 'g', escalate: 'x'.repeat(301) }])
    assert.throws(() => validBrief(body), e => e.key === 'errors.badBrief', JSON.stringify(body))
  assert.equal(validBrief({ goal: 'g', escalate: 'x'.repeat(300) }).escalate.length, 300)
})
