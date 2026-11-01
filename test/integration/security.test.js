import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import WebSocket from 'ws'
import { startServer, socket, waitFor } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

// fetch() won't let us forge Host, so use raw http.
function raw({ method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path, headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, r => {
      let data = ''; r.on('data', d => { data += d }); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: data }))
    })
    req.on('error', rej)
    if (body) req.write(body)
    req.end()
  })
}
const alive = async () => assert.equal((await raw({ path: '/api/state' })).status, 200)
const json = { 'content-type': 'application/json' }

test('foreign Host header is refused (DNS rebinding)', async () => {
  assert.equal((await raw({ path: '/api/state', headers: { host: 'evil.com' } })).status, 403)
  assert.equal((await raw({ path: '/', headers: { host: `evil.com:${srv.port}` } })).status, 403)
  assert.equal((await raw({ path: '/api/state', headers: { host: `localhost:${srv.port}` } })).status, 200)
})

test('cross-origin POST is refused (CSRF), same-origin passes', async () => {
  const body = JSON.stringify({ path: '/nonexistent' })
  assert.equal((await raw({ method: 'POST', path: '/api/repos', headers: { ...json, origin: 'http://evil.com' }, body })).status, 403)
  assert.equal((await raw({ method: 'POST', path: '/api/repos', headers: { ...json, origin: `http://localhost:${srv.port + 1}` }, body })).status, 403)
  assert.equal((await raw({ method: 'POST', path: '/api/repos', headers: { ...json, origin: `http://127.0.0.1:${srv.port}` }, body })).status, 400, 'reaches the route')
})

test('non-JSON POST is refused (no simple-request CSRF)', async () => {
  assert.equal((await raw({ method: 'POST', path: '/api/repos', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await raw({ method: 'POST', path: '/api/repos', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status, 415)
})

test('WebSocket: foreign or missing Origin rejected, same origin gets the state', async () => {
  for (const origin of ['http://evil.com', undefined]) {
    const sock = new WebSocket(`ws://127.0.0.1:${srv.port}`, origin ? { origin } : {})
    const err = await new Promise(r => { sock.once('error', r); sock.once('open', () => r(null)) })
    assert.ok(err, `origin ${origin} must be rejected`)
    assert.match(err.message, /401/)
  }
  const s = socket(srv.base); await s.open
  const first = await waitFor(() => s.msgs[0], { what: 'initial state' })
  assert.equal(first.t, 'state')
  assert.ok(Array.isArray(first.workspaces))
  s.close()
})

test('prototype keys under /vendor/ are 404 and do not crash the server', async () => {
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal((await raw({ path: `/vendor/${k}` })).status, 404, k)
  }
  await alive()
  assert.equal((await raw({ path: '/vendor/xterm.js' })).status, 200)
})

test('path traversal is not served', async () => {
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/vendor/../../package.json', '/%2e%2e%2f%2e%2e%2fetc/passwd']) {
    const r = await raw({ path })
    assert.equal(r.status, 404, path)
    assert.ok(!r.body.includes('"name": "aiguillage"'), path)
  }
  await alive()
})

test('pages carry a CSP that keeps the UI off the network', async () => {
  const r = await raw({ path: '/' })
  assert.equal(r.status, 200)
  const csp = r.headers['content-security-policy']
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /img-src 'self' data:/)
  assert.match(csp, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${srv.port} ws://localhost:${srv.port}`))
  assert.doesNotMatch(csp, /\*/)
})

test('unknown routes 404, malformed bodies 400, oversized bodies 413 fast, server survives', async () => {
  assert.equal((await raw({ path: '/api/nope' })).status, 404)
  assert.equal((await raw({ path: '/api/workspaces/missing/log' })).status, 400)
  assert.equal((await raw({ method: 'POST', path: '/api/repos', headers: json, body: '{not json' })).status, 400)
  // Answered (or the socket closed) without reading the body: must never leave the client hanging.
  const t0 = Date.now()
  const big = await raw({ method: 'POST', path: '/api/repos', headers: json, body: JSON.stringify({ path: 'x'.repeat(1_100_000) }) }).catch(e => e)
  assert.ok(big.status === 413 || big.code === 'ECONNRESET' || big.code === 'EPIPE', `oversized body: ${big.status ?? big.code}`)
  assert.ok(Date.now() - t0 < 5000, `oversized body answered in ${Date.now() - t0}ms`)
  await alive()
})

test('garbage WebSocket messages do not crash the server', async () => {
  const s = socket(srv.base); await s.open
  for (const m of ['not json', 'null', '[]', '42', '"str"', '{"key":null}', '{"t":"term:in","key":"nope:shell","data":"x"}', '{"t":"term:open","key":{"a":1}}']) s.sock.send(m)
  await new Promise(r => setTimeout(r, 300))
  await alive()
  assert.equal(s.sock.readyState, WebSocket.OPEN)
  s.close()
})

test('server listens on 127.0.0.1 only', async t => {
  const others = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
  const refused = host => new Promise(r => {
    const c = net.connect({ host, port: srv.port }); c.setTimeout(1500)
    c.once('connect', () => { c.destroy(); r(false) }); c.once('error', () => r(true)); c.once('timeout', () => { c.destroy(); r(true) })
  })
  assert.ok(await refused('::1'), 'not on IPv6 loopback')
  if (!others.length) return t.skip('no external interface')
  assert.ok(await refused(others[0]), `not reachable on ${others[0]}`)
})
