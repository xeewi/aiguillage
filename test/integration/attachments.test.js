import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, lastText } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const upload = (id, name, body, type = 'application/octet-stream') =>
  fetch(`${srv.base}/api/workspaces/${id}/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': type }, body })

test('attachments: upload any file, send it, the agent gets its path; nothing lands in the worktree', async () => {
  const { w } = await setup(srv)
  const pdf = await (await upload(w.id, 'spec v2.pdf', '%PDF-1.4 fake')).json()
  const png = await (await upload(w.id, 'shot.png', 'png bytes')).json()
  assert.equal(pdf.name, 'spec v2.pdf')
  assert.equal(readFileSync(pdf.path, 'utf8'), '%PDF-1.4 fake')
  assert.ok(!pdf.path.startsWith(w.path), 'stored outside the worktree')
  assert.equal(pdf.url, undefined, 'only images get a preview URL')

  const r = await fetch(srv.base + png.url)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.equal(await r.text(), 'png bytes')

  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'look', files: [pdf.path, png.path] })
  await srv.idle(w.id)
  const log = await srv.log(w.id)
  assert.deepEqual(log[0].files.map(f => f.name), ['spec v2.pdf', 'shot.png'])
  assert.match(lastText(log), new RegExp(pdf.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const argv = srv.fakeArgv().at(-1).argv
  assert.equal(argv[argv.indexOf('--add-dir') + 1], join(srv.home, 'attachments', w.id), 'the agent may read them without asking')
  assert.equal((await srv.api('GET', `/workspaces/${w.id}/diff`)).diff, '')
})

test('attachments: files alone can be sent; foreign paths and empty messages are refused', async () => {
  const { w } = await setup(srv)
  const { w: other } = await setup(srv)
  const f = await (await upload(w.id, 'data.csv', 'a,b\n1,2\n')).json()
  await assert.rejects(srv.api('POST', `/workspaces/${other.id}/send`, { text: '', files: [f.path] }), /Write a message or attach a file/)
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/send`, { text: ' ', files: ['/etc/passwd'] }), /Write a message or attach a file/)
  await srv.api('POST', `/workspaces/${w.id}/send`, { files: [f.path] })
  await srv.idle(w.id)
  assert.match((await srv.ws(w.id)).title, /data\.csv/, 'named from the files when there is no text')
})

test('attachments: names are sanitised, size is capped, only raw bodies, previews only for images under attachments/', async () => {
  const { w } = await setup(srv)
  const f = await (await upload(w.id, '../../../evil\u0001.sh', 'x')).json()
  assert.equal(f.name, 'evil_.sh')
  assert.ok(f.path.startsWith(join(srv.home, 'attachments', w.id) + '/'))
  assert.equal((await upload(w.id, 'a.txt', 'x', 'application/json')).status, 415)
  // Refused on its announced size: answered 413 or the socket closed before the body is read.
  const big = await upload(w.id, 'big.bin', new Uint8Array(100e6 + 1)).catch(e => e)
  assert.ok(big.status === 413 || big instanceof TypeError, `oversized upload: ${big.status ?? big.message}`)
  const html = await (await upload(w.id, 'page.html', '<script>alert(1)</script>')).json()
  const rel = html.path.slice(join(srv.home, 'attachments').length)
  assert.equal((await fetch(srv.base + '/attachments' + rel)).status, 404, 'HTML is never served back')
  assert.equal((await fetch(srv.base + '/attachments/..%2F..%2Fstate.json')).status, 404)
})

test('attachments: deleting the workspace removes its files', async () => {
  const { w } = await setup(srv)
  const f = await (await upload(w.id, 'a.txt', 'x')).json()
  await srv.api('DELETE', `/workspaces/${w.id}`)
  assert.equal(existsSync(f.path), false)
})
