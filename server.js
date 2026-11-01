#!/usr/bin/env node
import http from 'node:http'
import { readFileSync, existsSync, statSync, readdirSync, copyFileSync, mkdirSync, createWriteStream } from 'node:fs'
import { join, extname, basename, resolve, dirname, sep } from 'node:path'
import { homedir, platform } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { state, save, readLog, newId, WORKTREES, runLogPath } from './lib/store.js'
import { config as readConfig, defaultRun } from './lib/config.js'
import * as G from './lib/git.js'
import * as A from './lib/agent.js'
import { fail, notice } from './lib/i18n.js'

const exec = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 4317)
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const SHELL = process.env.SHELL || '/bin/zsh'

// ---------- live updates ----------
const clients = new Set()
const broadcast = msg => { const s = JSON.stringify(msg); for (const c of clients) c.send(s) }
const view = () => ({
  repos: state.repos,
  defaults: state.defaults ?? {},
  workspaces: state.workspaces.map(w => ({ ...w, ...A.runtime(w.id), scriptRunning: terms.get(w.id + ':script')?.alive ? terms.get(w.id + ':script').label : null })),
})
let pendingState = null
const changed = () => { pendingState ??= setTimeout(() => { pendingState = null; broadcast({ t: 'state', ...view() }) }, 30) }
A.wire(broadcast, changed)

// ---------- terminals (shell + scripts), one pty per key ----------
const terms = new Map() // key -> { p, buf, alive }
function openTerm(key, ws, cmd, label) {
  const old = terms.get(key)
  if (old?.alive && !cmd) return old
  if (old?.alive) old.p.kill()
  const args = cmd ? ['-lc', cmd] : ['-l']
  const p = pty.spawn(SHELL, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: ws?.path ?? homedir(), env: ws ? A.envFor(ws) : A.cleanEnv() })
  const t = { p, buf: cmd ? `\x1b[2m$ ${cmd}\x1b[0m\r\n` : '', alive: true, label }
  terms.set(key, t)
  // Script output also goes to a plain-text file the agent is told about.
  const log = key.endsWith(':script') ? createWriteStream(runLogPath(ws.id)) : null
  log?.write(`$ ${cmd}\n`)
  broadcast({ t: 'term:reset', key, data: t.buf })
  p.onData(d => {
    t.buf = (t.buf + d).slice(-200_000)
    broadcast({ t: 'term:data', key, data: d })
    log?.write(d.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, ''))
  })
  p.onExit(({ exitCode }) => {
    if (terms.get(key) !== t) return
    t.alive = false
    log?.end(`\n[exit ${exitCode}]\n`)
    const end = cmd ? `\r\n\x1b[2m[exited, code ${exitCode}]\x1b[0m\r\n` : ''
    t.buf += end
    broadcast({ t: 'term:data', key, data: end })
    broadcast({ t: 'term:exit', key, code: exitCode })
    changed()
  })
  changed()
  return t
}
function killTerms(wsId) {
  for (const [k, t] of terms) if (k.startsWith(wsId + ':')) { if (t.alive) t.p.kill(); terms.delete(k) }
}

// ---------- first-run setup: what a newcomer still has to install ----------
// The native installer puts `claude` in ~/.local/bin, often not yet on PATH (and never on the Finder app's).
const LOCAL_BIN = join(homedir(), '.local/bin')
if (!process.env.PATH.split(':').includes(LOCAL_BIN)) process.env.PATH += ':' + LOCAL_BIN
const CLAUDE = () => process.env.AIGUILLAGE_CLAUDE || 'claude'
const sh = (cmd, args) => exec(cmd, args, { env: A.cleanEnv(), timeout: 15_000 }).then(r => r.stdout.trim(), () => null)
async function doctor() {
  const [git, claude] = await Promise.all([sh('git', ['--version']), sh(CLAUDE(), ['--version'])])
  let loggedIn = false
  if (claude) try { loggedIn = JSON.parse(await sh(CLAUDE(), ['auth', 'status'])).loggedIn === true } catch {}
  return { git: !!git, claude: !!claude, loggedIn }
}
// Fixed commands only: the page picks a step, never the command.
const SETUP = {
  git: 'xcode-select --install',
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  login: `${CLAUDE()} auth login`,
}

// ---------- repo config (see lib/config.js) ----------
const rootOf = ws => state.repos.find(r => r.id === ws.repoId)?.path
const config = ws => readConfig(ws.path, rootOf(ws))

// ---------- workspaces ----------
const NAMES = 'tokyo lima oslo dakar quito hanoi kyoto lagos lisbon nairobi osaka porto riga sofia tunis vienna zagreb accra bern cairo delhi dublin havana kabul lhasa malmo nice perth rabat seoul tallinn tbilisi turin warsaw yerevan bogota cusco fes gdansk ghent'.split(' ')
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

async function createWorkspace({ repoId, name, base }) {
  const repo = state.repos.find(r => r.id === repoId)
  if (!repo) throw fail('errors.unknownRepo')
  base ||= repo.base
  if (!(await G.git(repo.path, ['rev-parse', '-q', '--verify', 'HEAD']).then(() => true, () => false)))
    throw fail('errors.noCommit')
  const taken = new Set([...state.workspaces.filter(w => w.repoId === repoId).map(w => w.name), ...(await G.branches(repo.path)).map(b => b.replace(/^aig\//, ''))])
  let n = slug(name) || NAMES.find(x => !taken.has(x)) || 'ws'
  for (let i = 2, b = n; taken.has(n); i++) n = `${b}-v${i}`
  const path = join(WORKTREES, `${basename(repo.path)}-${repo.id}`, n)
  mkdirSync(dirname(path), { recursive: true })
  // Start from the latest remote commit when there is an origin (best effort: offline is fine).
  let baseRef = base
  if ((await G.git(repo.path, ['remote']).catch(() => '')).split('\n').includes('origin')) {
    await exec('git', ['fetch', '--quiet', 'origin', base], { cwd: repo.path, timeout: 20_000 }).catch(() => {})
    if (await G.git(repo.path, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${base}`]).then(() => true, () => false)) baseRef = `origin/${base}`
  }
  await G.addWorktree(repo.path, path, `aig/${n}`, baseRef)
  // Gitignored files (env, certificates…) don't come with a worktree. Copied, in this order of precedence:
  // .worktreeinclude, else file_include_globs, else .env*
  const inc = join(repo.path, '.worktreeinclude')
  const globs = readConfig(path, repo.path).fileIncludeGlobs
  const files = await G.untrackedMatching(repo.path, existsSync(inc) ? { from: inc } : { patterns: globs?.length ? globs : ['.env*'] }).catch(() => [])
  for (const f of files) {
    if (existsSync(join(path, f))) continue
    mkdirSync(dirname(join(path, f)), { recursive: true })
    copyFileSync(join(repo.path, f), join(path, f))
  }
  const used = new Set(state.workspaces.map(w => w.port))
  let port = 40000
  while (used.has(port)) port += 10
  const ws = { id: newId(), repoId, name: n, branch: `aig/${n}`, base, baseRef, path, port, createdAt: Date.now(), permissionMode: 'auto', model: state.defaults?.model ?? '', effort: state.defaults?.effort ?? '' }
  state.workspaces.push(ws)
  save()
  const { setup } = config(ws)
  if (setup) openTerm(ws.id + ':script', ws, setup, 'setup')
  changed()
  return ws
}

async function archive(ws) {
  const { archive: script } = config(ws)
  if (script) await exec(SHELL, ['-lc', script], { cwd: ws.path, env: A.envFor(ws), timeout: 60_000 }).catch(() => {})
  A.stop(ws)
  killTerms(ws.id)
  const repo = state.repos.find(r => r.id === ws.repoId)
  // Uncommitted work survives archiving: pinned now, put back on unarchive.
  if (existsSync(ws.path) && await G.status(ws.path)) {
    ws.archiveCp = await G.snapshot(ws.path)
    await G.pin(ws.path, `refs/aiguillage/${ws.id}/archive`, ws.archiveCp)
  }
  await G.removeWorktree(repo.path, ws.path)
  ws.archived = Date.now()
  save(); changed()
}

async function unarchive(ws) {
  const repo = state.repos.find(r => r.id === ws.repoId)
  await G.git(repo.path, ['worktree', 'add', ws.path, ws.branch])
  if (ws.archiveCp) await G.restore(ws.path, ws.archiveCp)
  delete ws.archived; delete ws.archiveCp
  save(); changed()
}

async function merge(ws) {
  if (await G.status(ws.path)) throw fail('errors.uncommittedWorkspace')
  const repo = state.repos.find(r => r.id === ws.repoId)
  const cur = (await G.git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (cur === ws.base) {
    if (await G.status(repo.path)) throw fail('errors.uncommittedMain', { base: ws.base })
    await G.git(repo.path, ['merge', '--no-ff', '--no-edit', ws.branch]).catch(async e => {
      await G.git(repo.path, ['merge', '--abort']).catch(() => {})
      throw fail('errors.mergeConflict', { base: ws.base, detail: e.stdout || e.message })
    })
    return notice('messages.merged', { base: ws.base })
  }
  // Base not checked out in the main repo: fast-forward its ref only (git refuses anything unsafe).
  await G.git(repo.path, ['fetch', '.', `${ws.branch}:${ws.base}`])
  return notice('messages.fastForward', { base: ws.base, branch: ws.branch })
}

async function suggestRepos() {
  const known = new Set(state.repos.map(r => r.path))
  const out = []
  for (const d of ['code', 'dev', 'projects', 'src', 'Developer', 'Documents/GitHub', 'git'].map(d => join(homedir(), d))) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (!known.has(p) && existsSync(join(p, '.git'))) out.push(p)
    }
  }
  return out.slice(0, 50)
}

// A plain folder becomes a repo, its current files in a first commit (worktrees start from HEAD).
async function initRepo(dir) {
  if (dir === homedir() || dir === dirname(dir) || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw fail('errors.initRefused')
  await G.git(dir, ['init', '-q'])
  await G.git(dir, ['add', '-A'])
  await G.git(dir, ['commit', '-q', '--allow-empty', '-m', 'Start'])
  return G.isRepo(dir)
}

// Native folder picker: Electron's when the server runs inside the app, AppleScript's in browser mode.
async function pickFolder() {
  if (process.versions.electron) {
    const { dialog, BrowserWindow } = await import('electron')
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: ['openDirectory', 'createDirectory'] })
    return { path: r.canceled ? null : r.filePaths[0] }
  }
  const { stdout } = await exec('osascript', ['-e', 'POSIX path of (choose folder)']).catch(() => ({ stdout: '' }))
  return { path: stdout.trim().replace(/(.)\/$/, '$1') || null }
}

// ---------- HTTP API ----------
const routes = {
  'GET /api/state': () => view(),
  'GET /api/suggest': suggestRepos,
  'GET /api/doctor': doctor,
  'POST /api/pick': pickFolder,
  'POST /api/setup': ({ body }) => {
    if (!Object.hasOwn(SETUP, body.step)) throw fail('errors.notFound')
    openTerm('setup', null, SETUP[body.step], body.step); return {}
  },
  // Model and effort given to new workspaces ('' = the CLI's own default).
  'PATCH /api/defaults': ({ body }) => {
    state.defaults = { model: String(body.model ?? ''), effort: String(body.effort ?? '') }
    save(); changed(); return state.defaults
  },
  'POST /api/repos': async ({ body }) => {
    const dir = resolve(String(body.path).replace(/^~(?=$|\/)/, homedir()))
    let path = await G.isRepo(dir)
    if (!path && body.init) path = await initRepo(dir)
    if (!path) throw fail('errors.notRepo')
    const existing = state.repos.find(r => r.path === path)
    if (existing) return existing
    const repo = { id: newId(), path, name: basename(path), base: await G.defaultBranch(path) }
    state.repos.push(repo); save(); changed()
    return repo
  },
  'PATCH /api/repos/:id': ({ repo, body }) => { if (body.base) repo.base = body.base; save(); changed(); return repo },
  'DELETE /api/repos/:id': ({ repo }) => {
    if (state.workspaces.some(w => w.repoId === repo.id && !w.archived)) throw fail('errors.archiveWorkspacesFirst')
    state.repos = state.repos.filter(r => r !== repo); save(); changed(); return {}
  },
  'GET /api/repos/:id/branches': ({ repo }) => G.branches(repo.path),
  'POST /api/workspaces': ({ body }) => createWorkspace(body),
  'GET /api/workspaces/:id/log': ({ ws }) => readLog(ws.id),
  'GET /api/workspaces/:id/diff': async ({ ws }) => ({ diff: (await G.diff(ws.path, ws.baseRef || ws.base)).slice(0, 3_000_000), status: await G.status(ws.path) }),
  'PATCH /api/workspaces/:id': ({ ws, body }) => {
    // Rename. Empty: back to the city name, and the next message names it again.
    if (typeof body.title === 'string') ws.title = body.title.replace(/\s+/g, ' ').trim().slice(0, 80)
    A.configure(ws, body); changed(); return {}
  },
  'POST /api/workspaces/:id/send': async ({ ws, body }) => { await A.send(ws, String(body.text)); return {} },
  'POST /api/workspaces/:id/interrupt': ({ ws }) => { A.interrupt(ws); return {} },
  'POST /api/workspaces/:id/permission': ({ ws, body }) => { A.answer(ws, body.id, !!body.allow, body.message && String(body.message)); return {} },
  'POST /api/workspaces/:id/revert': async ({ ws, body }) => ({ text: await A.revert(ws, body.msgId) }),
  'POST /api/workspaces/:id/archive': async ({ ws }) => { await archive(ws); return {} },
  'POST /api/workspaces/:id/unarchive': async ({ ws }) => { await unarchive(ws); return {} },
  'DELETE /api/workspaces/:id': async ({ ws }) => {
    if (!ws.archived) await archive(ws)
    const repo = state.repos.find(r => r.id === ws.repoId)
    await G.git(repo.path, ['branch', '-D', ws.branch]).catch(() => {})
    await G.dropRefs(repo.path, `refs/aiguillage/${ws.id}/`).catch(() => {})
    state.workspaces = state.workspaces.filter(w => w !== ws); save(); changed(); return {}
  },
  'GET /api/workspaces/:id/scripts': ({ ws }) => { const c = config(ws); return { run: c.run, default: defaultRun(c) } },
  'POST /api/workspaces/:id/run': ({ ws, body }) => {
    const c = config(ws), id = body.id && Object.hasOwn(c.run, body.id) ? body.id : defaultRun(c)
    if (!id) throw fail('errors.noRunScript')
    // nonconcurrent: only one workspace of this repo may run at a time (shared ports, DB…)
    if (c.runMode === 'nonconcurrent') for (const w of state.workspaces) {
      const t = w.repoId === ws.repoId && w !== ws && terms.get(w.id + ':script')
      if (t?.alive) t.p.kill()
    }
    openTerm(ws.id + ':script', ws, c.run[id].command, id); return {}
  },
  'POST /api/workspaces/:id/run-stop': ({ ws }) => { const t = terms.get(ws.id + ':script'); if (t?.alive) t.p.kill(); return {} },
  'POST /api/workspaces/:id/commit': async ({ ws, body }) => {
    await G.git(ws.path, ['add', '-A'])
    await G.git(ws.path, ['commit', '-m', String(body.message || `aiguillage: ${ws.name}`)])
    return notice('messages.committed')
  },
  'POST /api/workspaces/:id/merge': async ({ ws }) => merge(ws),
  'POST /api/workspaces/:id/pr': async ({ ws }) => {
    await G.git(ws.path, ['push', '-u', 'origin', ws.branch])
    const { stdout } = await exec('gh', ['pr', 'create', '--fill', '--head', ws.branch, '--base', ws.base], { cwd: ws.path })
    return { message: stdout.trim() }
  },
  'POST /api/workspaces/:id/open': ({ ws, body }) => {
    const cmd = body.app === 'code' ? ['code', [ws.path]] : [platform() === 'darwin' ? 'open' : 'xdg-open', [ws.path]]
    spawn(...cmd, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return {}
  },
}

// Nothing rendered (e.g. an image in agent markdown) may reach the network.
const CSP = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; base-uri 'none'; form-action 'self'`
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
// Only these node_modules files are served; nothing is loaded from the internet.
const VENDOR = {
  'xterm.js': '@xterm/xterm/lib/xterm.mjs', 'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.mjs', 'marked.js': 'marked/lib/marked.esm.js',
  'purify.js': 'dompurify/dist/purify.es.mjs',
  'i18next.js': 'i18next/dist/esm/i18next.js', 'i18next-languagedetector.js': 'i18next-browser-languagedetector/dist/esm/i18nextBrowserLanguageDetector.js',
}

function serveStatic(url, res) {
  let file
  const name = url.slice(8)
  if (url.startsWith('/vendor/')) file = Object.hasOwn(VENDOR, name) && join(ROOT, 'node_modules', VENDOR[name])
  else {
    const pub = join(ROOT, 'public')
    file = resolve(pub, '.' + (url === '/' ? '/index.html' : url))
    if (!file.startsWith(pub + sep)) file = null
  }
  if (!file || !existsSync(file)) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': (MIME[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP })
  res.end(readFileSync(file))
}

// A web page you visit must not be able to drive local agents: check Host (DNS rebinding) and Origin (CSRF).
const sameOrigin = req => HOSTS.has(req.headers.host) && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`)

const server = http.createServer(async (req, res) => {
  if (!sameOrigin(req)) { res.writeHead(403); return res.end('forbidden') }
  const url = new URL(req.url, 'http://x')
  if (!url.pathname.startsWith('/api/')) {
    try { return serveStatic(url.pathname, res) } catch { res.writeHead(500); return res.end() }
  }
  if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') { res.writeHead(415); return res.end() }
  const parts = url.pathname.split('/') // ['', 'api', kind, id, action]
  const key = `${req.method} ${parts.length > 3 ? ['', 'api', parts[2], ':id', ...parts.slice(4)].join('/') : url.pathname}`
  const route = routes[key]
  if (!route) { res.writeHead(404); return res.end() }
  // Too big: answer 413 and close right away (an unread body would otherwise keep the client hanging).
  const tooBig = () => {
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ error: 'Request too large.', key: 'errors.tooLarge' }), () => req.destroy())
  }
  if (Number(req.headers['content-length']) > 1e6) return tooBig()
  try {
    let raw = ''
    for await (const c of req) { raw += c; if (raw.length > 1e6) return tooBig() }
    const ctx = { body: raw ? JSON.parse(raw) : {} }
    if (parts[3]) {
      ctx.ws = state.workspaces.find(w => w.id === parts[3])
      ctx.repo = state.repos.find(r => r.id === parts[3])
      if (!ctx[parts[2] === 'repos' ? 'repo' : 'ws']) throw fail('errors.notFound')
    }
    const out = await route(ctx)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out ?? {}))
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (e.stderr || e.message || String(e)).trim(), key: e.key, vars: e.vars }))
  }
})

const wss = new WebSocketServer({ server, verifyClient: ({ req }) => sameOrigin(req) && !!req.headers.origin })
wss.on('error', () => {}) // ws re-emits the HTTP server's listen errors; `ready` below reports them
wss.on('connection', sock => {
  clients.add(sock)
  sock.on('close', () => clients.delete(sock))
  sock.send(JSON.stringify({ t: 'state', ...view() }))
  sock.on('message', raw => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (!m || typeof m !== 'object') return
    const ws = state.workspaces.find(w => w.id === String(m.key).split(':')[0])
    if (m.key !== 'setup' && (!ws || ws.archived)) return
    if (m.t === 'term:open') {
      const t = m.key.endsWith(':shell') ? openTerm(m.key, ws) : terms.get(m.key)
      sock.send(JSON.stringify({ t: 'term:reset', key: m.key, data: t?.buf ?? '' }))
    }
    const t = terms.get(m.key)
    if (!t?.alive) return
    if (m.t === 'term:in') t.p.write(String(m.data))
    if (m.t === 'term:resize' && m.cols > 0 && m.rows > 0) t.p.resize(m.cols | 0, m.rows | 0)
  })
})

// The desktop app (electron/main.js) imports this module: it waits on `ready` and calls `shutdown` on quit.
export const ready = new Promise((ok, fail) => {
  server.once('error', fail)
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`
    console.log(`Aiguillage → ${url}`)
    if (!process.argv.includes('--no-open') && !process.versions.electron) spawn(platform() === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    ok(url)
  })
})
if (!process.versions.electron) ready.catch(e => { console.error(`[aiguillage] ${e.message}`); process.exit(1) })
export function shutdown() {
  for (const w of state.workspaces) A.stop(w)
  for (const t of terms.values()) if (t.alive) t.p.kill()
}
process.on('uncaughtException', e => console.error('[aiguillage]', e))
process.on('unhandledRejection', e => console.error('[aiguillage]', e))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(0) })
