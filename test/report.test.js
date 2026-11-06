import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReport, excerpt, REPORT_RULES } from '../lib/report.js'

test('parseReport reads the last aig-report block', () => {
  const r = parseReport('Fixed it.\n\n```aig-report\nstatus: done\nchecks: npm test → 127 pass\nunverified: e2e\nneeds: none\n```')
  assert.deepEqual(r, { status: 'done', checks: 'npm test → 127 pass', unverified: 'e2e', needs: 'none', body: 'Fixed it.' })
})
test('no block, or an unknown status: status null, text kept whole', () => {
  assert.deepEqual(parseReport('just words'), { status: null, checks: '', unverified: '', needs: '', body: 'just words' })
  assert.equal(parseReport('```aig-report\nstatus: maybe\n```').status, null)
})
test('the last block wins; a missing field is an empty string', () => {
  const r = parseReport('```aig-report\nstatus: done\n```\nmore\n```aig-report\nstatus: blocked\nneeds: a key\n```')
  assert.deepEqual([r.status, r.needs, r.checks, r.body], ['blocked', 'a key', '', '```aig-report\nstatus: done\n```\nmore'])
})
test('excerpt keeps the block whole when the body is cut', () => {
  const block = '```aig-report\nstatus: blocked\nchecks: none\nunverified: all\nneeds: the API key\n```'
  const out = excerpt('x'.repeat(5000) + '\n\n' + block, 2000)
  assert.ok(out.length <= 2000 + 1)
  assert.ok(out.endsWith(block))
  assert.equal(excerpt('short', 2000), 'short')
  assert.equal(excerpt('y'.repeat(30), 10), 'y'.repeat(10) + '…', 'no block: plain cut')
})
test('REPORT_RULES shows the block format', () => {
  assert.match(REPORT_RULES, /^End every turn with this block[^\n]*\n```aig-report\nstatus: done \| blocked \| decision\n/)
  assert.match(REPORT_RULES, /before you go on\.$/)
})
test('a block quoted inline after the real one does not win: fences count at line starts only', () => {
  const text = 'Stuck.\n\n```aig-report\nstatus: blocked\nneeds: a key\n```\nThe format is like ```aig-report\nstatus: done\n``` there.'
  assert.equal(parseReport(text).status, 'blocked')
  assert.equal(parseReport('```aig-report\n```').status, null, 'an empty block still parses')
})
test('a block indented (in a list) or with CRLF line endings still reads', () => {
  const r = parseReport('Done:\n  ```aig-report\n  status: blocked\n  needs: a key\n  ```')
  assert.deepEqual([r.status, r.needs, r.body], ['blocked', 'a key', 'Done:'])
  const crlf = parseReport('Fixed.\r\n\r\n```aig-report\r\nstatus: done\r\nchecks: npm test\r\n```\r\n')
  assert.deepEqual([crlf.status, crlf.checks, crlf.body], ['done', 'npm test', 'Fixed.'])
})
