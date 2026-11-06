// Shared test helpers: an isolated Aiguillage server driving the fake claude, and throwaway git repos.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import WebSocket from 'ws'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FAKE = join(ROOT, 'test/fake-claude.mjs')
export const tmp = (p = 'aig-') => realpathSync(mkdtempSync(join(tmpdir(), p)))
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function waitFor(fn, { timeout = 10_000, every = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`timeout waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// files: { 'path': 'content' }; returns the repo path. opts.origin: also create a bare origin.
export function makeRepo(files = { 'README.md': '# test\n' }, { origin = false } = {}) {
  const dir = tmp('cgrepo-')
  const repo = join(dir, 'repo')
  git(dir, 'init', '-q', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), c) }
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init')
  if (origin) {
    const bare = join(dir, 'origin.git')
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare)
    git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-q', 'origin', 'main')
  }
  return repo
}

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

// Starts server.js with its own state dir, the fake claude and a fake home (for ~/.aiguillage/settings.toml).
export async function startServer({ home = tmp('cghome-'), env = {} } = {}) {
  const port = await freePort()
  const fakeLog = join(home, 'fake-argv.jsonl')
  const proc = spawn(process.execPath, [join(ROOT, 'server.js'), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, AIGUILLAGE_HOME: home, PORT: String(port), AIGUILLAGE_CLAUDE: FAKE, AIGUILLAGE_TOKEN: 'test-token', FAKE_CLAUDE_HOME: join(home, 'fake-sessions'), FAKE_CLAUDE_LOG: fakeLog, HOME: home, AIGUILLAGE_TEST: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  proc.stdout.on('data', d => { output += d }); proc.stderr.on('data', d => { output += d })
  await waitFor(() => output.includes('Aiguillage →'), { what: 'server start', timeout: 15_000 })
  const base = `http://127.0.0.1:${port}`
  const call = (headers = {}) => async (method, path, body) => {
    const r = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { const e = new Error(j.error || r.statusText); Object.assign(e, { status: r.status, key: j.key, vars: j.vars }); throw e }
    return j
  }
  const api = call({ 'sec-fetch-site': 'same-origin' }) // what the page's browser sends
  const asAiguilleur = call({ authorization: 'Bearer test-token' })
  const state = () => api('GET', '/state')
  const ws = id => state().then(s => s.workspaces.find(w => w.id === id))
  const log = id => api('GET', `/workspaces/${id}/log`)
  const idle = (id, timeout) => waitFor(async () => { const w = await ws(id); return w && !w.busy && w }, { what: 'agent idle', timeout })
  // Send and wait for the turn's result to be logged.
  const turn = async (id, text, { timeout = 10_000 } = {}) => {
    const before = (await log(id)).filter(e => e.type === 'result').length
    await api('POST', `/workspaces/${id}/send`, { text })
    await waitFor(async () => (await log(id)).filter(e => e.type === 'result').length > before, { what: `result for "${text}"`, timeout })
    return lastText(await log(id))
  }
  // Test-only (AIGUILLAGE_TEST): snapshots taken per folder, overlap scans finished.
  const counters = () => api('GET', '/counters')
  // The counters once no git work runs any more (two equal reads 300 ms apart).
  const quiet = () => waitFor(async () => { const a = JSON.stringify(await counters()); await sleep(300); return a === JSON.stringify(await counters()) && JSON.parse(a) }, { what: 'no git work running' })
  // A turn, then the overlap scan it starts (what a brief's overlap warning reads); counted from a quiet start, so an
  // earlier scan ending meanwhile isn't taken for it.
  const turnScanned = async (id, text) => {
    const n = (await quiet()).scans
    const out = await turn(id, text)
    await waitFor(async () => (await counters()).scans > n, { what: 'the overlap scan after the turn' })
    return out
  }
  const fakeArgv = () => { try { return execFileSync('cat', [fakeLog], { encoding: 'utf8' }).trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
  const stop = () => new Promise(r => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill('SIGTERM') })
  return { port, base, home, proc, api, asAiguilleur, state, ws, log, idle, turn, turnScanned, counters, quiet, fakeArgv, stop, output: () => output }
}

export const lastText = evs => [...evs].reverse().find(e => e.type === 'assistant' && e.message.content.some(c => c.type === 'text'))?.message.content.find(c => c.type === 'text').text

// Collects every WebSocket message from the server.
export function socket(base, origin = base) {
  const msgs = []
  const sock = new WebSocket(base.replace('http', 'ws'), { origin })
  sock.on('message', m => msgs.push(JSON.parse(m)))
  const open = new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej) })
  return { sock, msgs, open, send: m => sock.send(JSON.stringify(m)), close: () => sock.close() }
}

// Adds a repo and creates a workspace in one go.
export async function setup(srv, files, opts) {
  const repoPath = makeRepo(files, opts)
  const repo = await srv.api('POST', '/repos', { path: repoPath })
  const w = await srv.api('POST', '/workspaces', { repoId: repo.id })
  return { repoPath, repo, w }
}
