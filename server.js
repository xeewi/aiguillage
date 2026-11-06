#!/usr/bin/env node
import http from 'node:http'
import { readFileSync, existsSync, statSync, readdirSync, copyFileSync, mkdirSync, createWriteStream, createReadStream, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, extname, basename, resolve, dirname, sep } from 'node:path'
import { homedir, platform } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { state, save, readLog, writeLog, newId, HOME, WORKTREES, runLogPath, ATTACHMENTS, attachDir, fileName } from './lib/store.js'
import * as Rv from './lib/review.js'
import { config as readConfig, defaultRun } from './lib/config.js'
import * as G from './lib/git.js'
import * as A from './lib/agent.js'
import { fail, notice } from './lib/i18n.js'
import * as U from './lib/update.js'
import * as R from './lib/remote.js'
import { validBrief, briefText } from './lib/brief.js'
import { metric, readMetrics, summarize } from './lib/metrics.js'

const exec = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 4317)
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
// The aiguilleur's secret (AIGUILLAGE_TOKEN overrides, for tests), in memory only: lib/agent.js hands it to its process alone.
const TOKEN = process.env.AIGUILLAGE_TOKEN || randomBytes(24).toString('hex')
delete process.env.AIGUILLAGE_TOKEN // git hooks, gh, update… inherit process.env: only the aiguilleur's spawn gets it
A.setToken(TOKEN)
const SHELL = process.env.SHELL || '/bin/zsh'
// The queue (sendTo): a new worker waits while MAX_AGENTS_DEFAULT (Settings: MAX_AGENTS_MIN to MAX_AGENTS_MAX) work, or
// while the plan's session is at QUOTA_HOLD_PCT % or more.
// ponytail: one cap for every repo and one session threshold; per repo or per model if anyone needs it.
const MAX_AGENTS_DEFAULT = 5, MAX_AGENTS_MIN = 1, MAX_AGENTS_MAX = 20
const QUOTA_HOLD_PCT = 90
// What the aiguilleur asks to do waits for the user's click (guard), across restarts too, at most this long.
// ponytail: checked at startup only; one older than a day is dropped then, not while the app runs.
const CONFIRM_TTL = 24 * 3600_000

// ---------- live updates ----------
const clients = new Set()
const broadcast = msg => { const s = JSON.stringify(msg); for (const c of clients) c.send(s) }
const view = () => ({
  repos: state.repos.map(r => ({ ...r, logo: logos.has(r.id) ? `/logo/${r.id}` : null })),
  defaults: { maxAgents: MAX_AGENTS_DEFAULT, ...state.defaults },
  update: U.info(),
  usage: A.usageNow(),
  workspaces: state.workspaces.map(w => ({ ...w, ...A.runtime(w.id), scriptRunning: terms.get(w.id + ':script')?.alive ? terms.get(w.id + ':script').label : null,
    claudeTerm: !!terms.get(w.id + ':claude')?.alive, checking: Rv.checking.has(w.id) })),
  telegram: R.info(),
  aiguilleur: state.aiguilleur && { ...state.aiguilleur, ...A.runtime('aiguilleur'), aiguilleur: true, brief: undefined },
})
let pendingState = null
const changed = () => { pendingState ??= setTimeout(() => { pendingState = null; broadcast({ t: 'state', ...view() }); R.sync(); drain() }, 30) }
A.wire(m => { broadcast(m); R.onEvent(m) }, changed)
Rv.wire(changed)

// ---------- project logos (lib/git.js findLogo), shown beside the repo name ----------
// ponytail: scanned at startup and when a repo is added; a logo added later shows after a restart.
const logos = new Map() // repo id -> absolute path
const scanLogo = r => G.findLogo(r.path).then(f => { if (f) { logos.set(r.id, join(r.path, f)); changed() } }, () => {})
const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
function serveLogo(pathname, res) {
  const file = logos.get(pathname.slice('/logo/'.length))
  if (!file || !existsSync(file)) { res.writeHead(404); return res.end('not found') }
  // An SVG from a cloned repo may carry script: never let it run, even opened on its own.
  res.writeHead(200, { 'content-type': LOGO_TYPES[extname(file).toLowerCase()], 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'cache-control': 'private, max-age=300' })
  createReadStream(file).pipe(res)
}

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

// The name a new workspace gets: the one asked (as a slug) or a free city, made unique (-v2…) in the repo.
async function freeName(repo, name) {
  const taken = new Set([...state.workspaces.filter(w => w.repoId === repo.id).map(w => w.name), ...(await G.branches(repo.path)).map(b => b.replace(/^aig\//, ''))])
  let n = slug(name) || NAMES.find(x => !taken.has(x)) || 'ws'
  for (let i = 2, b = n; taken.has(n); i++) n = `${b}-v${i}`
  return n
}

async function createWorkspace({ repoId, name, base }) {
  const repo = state.repos.find(r => r.id === repoId)
  if (!repo) throw fail('errors.unknownRepo')
  base ||= repo.base
  if (!(await G.git(repo.path, ['rev-parse', '-q', '--verify', 'HEAD']).then(() => true, () => false)))
    throw fail('errors.noCommit')
  const n = await freeName(repo, name)
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
  const ws = { id: newId(), repoId, name: n, branch: `aig/${n}`, base, baseRef, path, ...fresh() }
  state.workspaces.push(ws)
  save()
  const { setup } = config(ws)
  if (setup) openTerm(ws.id + ':script', ws, setup, 'setup')
  changed()
  return ws
}

// What every new workspace or session starts with: free ports and the defaults from Settings.
function fresh() {
  const used = new Set(state.workspaces.map(w => w.port))
  let port = 40000
  while (used.has(port)) port += 10
  return { port, createdAt: Date.now(), permissionMode: state.defaults?.permissionMode || 'auto', model: state.defaults?.model ?? '', effort: state.defaults?.effort ?? '' }
}

// A session tied to no project (the sidebar's « Sessions »): an agent in a folder of its own, no repo or worktree.
// The folder is a git repo of its own: checkpoints and revert work, and git never walks up into a tracked $HOME.
async function createSession() {
  const id = newId(), path = join(HOME, 'sessions', id)
  mkdirSync(path, { recursive: true })
  await G.git(path, ['init', '-q'])
  await G.git(path, ['commit', '-q', '--allow-empty', '-m', 'Start'], G.ID)
  const taken = new Set(state.workspaces.filter(w => w.free).map(w => w.name))
  const ws = { id, free: true, name: NAMES.find(x => !taken.has(x)) || 'session', branch: '', base: '', path, ...fresh() }
  state.workspaces.push(ws)
  save(); changed()
  return ws
}

// Archived, its queued messages are dropped (never sent): one report lists them.
function dropQueue(ws) {
  const q = ws.queued
  if (!q?.length) return
  delete ws.queued
  R.report(ws, { ok: true, key: 'queue.dropped', vars: { count: q.length, list: q.map(x => '- ' + (x.text.trim().split('\n')[0] || x.files.map(f => f.name).join(', ')).slice(0, 100)) } })
}

async function archive(ws) {
  dropQueue(ws)
  if (ws.free) { A.stop(ws); killTerms(ws.id); ws.archived = Date.now(); save(); changed(); return }
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
  save(); changed(); scanOverlaps() // its ⚠️ goes away
}

async function unarchive(ws) {
  if (ws.free) { delete ws.archived; save(); changed(); return }
  const repo = state.repos.find(r => r.id === ws.repoId)
  await G.git(repo.path, ['worktree', 'add', ws.path, ws.branch])
  if (ws.archiveCp) await G.restore(ws.path, ws.archiveCp)
  delete ws.archived; delete ws.archiveCp
  save(); changed(); scanOverlaps()
}

// With a check script, a merge wants a green check on exactly what is merged. 'failed' | 'stale' | null; refused unless forced.
// Same tree and same command (a check edited since says nothing about these files).
async function gate(ws, body) {
  const command = !ws.free && config(ws).check
  if (!command) return null
  const c = ws.check, same = Rv.fresh(c, (await G.snapshot(ws.path)).tree, command)
  const st = c?.ok && same ? null : c && !c.ok && same ? 'failed' : 'stale'
  if (st && !body?.force) throw fail('errors.checkNotGreen', { context: st })
  return st
}

// The merge route checked first: no uncommitted changes, then the gate.
async function merge(ws) {
  const repo = state.repos.find(r => r.id === ws.repoId)
  const cur = (await G.git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const tip = () => G.git(repo.path, ['rev-parse', ws.base]).then(s => s.trim(), () => null)
  const was = await tip()
  let out
  if (cur === ws.base) {
    if (await G.status(repo.path)) throw fail('errors.uncommittedMain', { base: ws.base })
    await G.git(repo.path, ['merge', '--no-ff', '--no-edit', ws.branch]).catch(async e => {
      await G.git(repo.path, ['merge', '--abort']).catch(() => {})
      throw fail('errors.mergeConflict', { base: ws.base, detail: e.stdout || e.message })
    })
    out = notice('messages.merged', { base: ws.base })
  } else {
    // Base not checked out in the main repo: fast-forward its ref only (git refuses anything unsafe).
    await G.git(repo.path, ['fetch', '.', `${ws.branch}:${ws.base}`])
    out = notice('messages.fastForward', { base: ws.base, branch: ws.branch })
  }
  await tellOthers(ws, repo, was, await tip()).catch(e => console.error('[overlap]', e.message))
  scanOverlaps()
  return out
}

// ---------- overlaps: two workspaces of a repo changing the same files ----------
const activeIn = (repoId, except) => state.workspaces.filter(w => w.repoId === repoId && !w.archived && !w.free && w !== except && existsSync(w.path))
const baseOf = w => w.baseRef || w.base
const mine = w => Rv.changedFiles(w.path, baseOf(w)).catch(() => [])

// The merge changed these files on the base: the other workspaces that changed some too hear it with their next message.
async function tellOthers(ws, repo, was, now) {
  if (!was || was === now) return
  const landed = (await G.git(repo.path, ['-c', 'core.quotePath=false', 'diff', '--name-only', was, now])).split('\n').filter(Boolean)
  const told = []
  for (const o of activeIn(repo.id, ws)) {
    const files = (await mine(o)).filter(f => landed.includes(f))
    if (!files.length) continue
    // English: the agent reads it, not the user.
    (o.notices ??= []).push(`Note from Aiguillage: ${ws.branch} was just merged into ${ws.base}. It changed files you changed too: ${files.join(', ')}. Rebase on ${ws.base} before going further.`)
    told.push(R.label(o))
  }
  if (!told.length) return
  save()
  R.report(ws, { ok: true, key: 'overlap.notified', vars: { branch: ws.branch, base: ws.base, who: told.join(', ') } })
}

// state.overlaps: { '<a>|<b>': files } as of the last scan; a new or changed pair is reported once.
// ponytail: runs every OVERLAP_EVERY and after each turn and merge; one scan at a time.
// Coalesced: one running and at most one waiting (it will see everything that changed before it starts).
let scanning = Promise.resolve(), queued = null
const scanOverlaps = () => queued ??= scanning.then(() => { queued = null; return scan() })
const scan = () => scanning = (async () => {
  const now = {}, news = []
  for (const repo of state.repos) {
    const list = []
    for (const w of activeIn(repo.id)) list.push({ id: w.id, files: await mine(w) })
    for (const o of Rv.overlaps(list.filter(x => x.files.length))) {
      const key = `${o.a}|${o.b}`
      now[key] = o.files.join('\n')
      if (state.overlaps?.[key] !== now[key]) news.push(o)
    }
  }
  const gone = JSON.stringify(Object.keys(state.overlaps ?? {})) !== JSON.stringify(Object.keys(now))
  state.overlaps = now
  if (news.length || gone) { save(); changed() }
  for (const o of news) {
    const a = state.workspaces.find(w => w.id === o.a), b = state.workspaces.find(w => w.id === o.b)
    R.report(a, { ok: true, status: 'decision', title: `${R.label(a)} ↔ ${R.label(b)}`, overlap: o.files,
      key: 'overlap.found', vars: { a: R.label(a), b: R.label(b), files: o.files.join(', ') } })
  }
})().catch(e => console.error('[overlap]', e.message))
setInterval(scanOverlaps, Rv.OVERLAP_EVERY).unref()

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

// ---------- chat attachments: any file type, stored per workspace outside the worktree ----------
const MAX_UPLOAD = 100e6
// Only these come back to the page (thumbnails); never SVG or HTML, which could run script in the app's origin.
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const fileInfo = path => {
  const name = basename(path)
  const url = IMAGES[extname(name).toLowerCase()] && '/attachments/' + path.slice(ATTACHMENTS.length + 1).split(sep).map(encodeURIComponent).join('/')
  return { name, path, url }
}
async function upload(ws, name, req) {
  // One folder per upload: the agent sees the file under its own name, and same-name files don't collide.
  const dir = join(attachDir(ws.id), newId())
  const path = join(dir, fileName(name))
  mkdirSync(dir, { recursive: true })
  let n = 0
  try {
    await pipeline(req, async function* (src) { for await (const c of src) { if ((n += c.length) > MAX_UPLOAD) throw fail('errors.fileTooLarge'); yield c } }, createWriteStream(path))
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e }
  return fileInfo(path)
}
// What the page sends back: only paths of this workspace's own uploads. The aiguilleur also passes its own on to an
// agent (what the user sent it from Telegram): copied, as an agent only reads its own folder.
const attached = (ws, paths) => (Array.isArray(paths) ? paths : []).map(p => resolve(String(p)))
  .filter(p => statSync(p, { throwIfNoEntry: false })?.isFile())
  .map(p => p.startsWith(attachDir(ws.id) + sep) ? p : p.startsWith(attachDir('aiguilleur') + sep) ? passOn(ws, p) : null)
  .filter(Boolean).map(fileInfo)
function passOn(ws, p) {
  const to = join(attachDir(ws.id), newId(), basename(p))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(p, to)
  return to
}
function serveAttachment(pathname, res) {
  const file = resolve(ATTACHMENTS, '.' + decodeURIComponent(pathname.slice('/attachments'.length)))
  const type = IMAGES[extname(file).toLowerCase()]
  if (!type || !file.startsWith(ATTACHMENTS + sep) || !existsSync(file)) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'private, max-age=86400' })
  createReadStream(file).pipe(res)
}

// ---------- media the agent shows in the chat: ![caption](path/to/shot.png | demo.mp4 | sound.mp3) ----------
// Typed by extension, with nosniff and a sandbox: a file only ever plays as the image, video or sound it claims to be.
// ponytail: any local path with a media extension, not only the worktree (screenshots often land in /tmp).
const MEDIA = { ...IMAGES, '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', // a .mov is H.264 nearly always; Chromium only plays it typed mp4
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' }
function serveMedia(query, req, res) {
  const file = resolve(String(query.get('path') ?? '').replace(/^~(?=$|\/)/, homedir()))
  const type = MEDIA[extname(file).toLowerCase()], st = type && statSync(file, { throwIfNoEntry: false })
  if (!st?.isFile()) { res.writeHead(404); return res.end('not found') }
  // same-origin: another site can't even embed it to probe which files you have.
  const head = { 'content-type': type, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'same-origin', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' }
  // Ranges, or a video can't seek.
  const [, a, b] = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '') ?? []
  if (a === undefined) { res.writeHead(200, { ...head, 'content-length': st.size }); return createReadStream(file).on('error', () => res.destroy()).pipe(res) }
  const start = a ? +a : Math.max(0, st.size - +b), end = a && b ? Math.min(+b, st.size - 1) : st.size - 1
  if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end() }
  res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 })
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
}

// ---------- HTTP API ----------
const routes = {
  'GET /api/state': () => view(),
  'GET /api/suggest': suggestRepos,
  'GET /api/doctor': doctor,
  'GET /api/metrics': ({ query }) => { const now = Date.now(); return summarize(readMetrics(now - (+query.get('days') || 14) * 86_400_000), now) },
  'POST /api/pick': pickFolder,
  'POST /api/setup': ({ body }) => {
    if (!Object.hasOwn(SETUP, body.step)) throw fail('errors.notFound')
    openTerm('setup', null, SETUP[body.step], body.step); return {}
  },
  // Model, effort ('' = the CLI's own default) and permission mode given to new workspaces; how many agents work at once.
  'PATCH /api/defaults': ({ body }) => {
    const permissionMode = ['default', 'acceptEdits', 'plan'].includes(body.permissionMode) ? body.permissionMode : 'auto'
    // Missing, empty or not a number: unchanged.
    const n = Math.round(parseFloat(body.maxAgents))
    state.defaults = { model: String(body.model ?? ''), effort: String(body.effort ?? ''), permissionMode, autoUpdate: body.autoUpdate !== false,
      maxAgents: Number.isFinite(n) ? Math.min(MAX_AGENTS_MAX, Math.max(MAX_AGENTS_MIN, n)) : state.defaults?.maxAgents ?? MAX_AGENTS_DEFAULT }
    save(); changed(); return state.defaults
  },
  // Settings → Telegram: a bot token ('' disconnects); the page then gets the link that ties the user's chat to it.
  'POST /api/telegram': async ({ body }) => { await R.connect(body.token); return {} },
  // Remote mode (sidebar button): Telegram gets the reports and requests, after a catch-up.
  'PATCH /api/telegram': async ({ body }) => {
    if (body.digest !== undefined) R.setDigest(body.digest)
    if (body.remote !== undefined) await R.setRemote(!!body.remote)
    return {}
  },
  // Desktop app: restart into the downloaded update (lib/update.js).
  'POST /api/update': () => { U.install(); return {} },
  // Same as the app menu's « Check for updates… »; progress comes back through the state broadcasts.
  'POST /api/check-update': () => { U.check(true); return {} },
  'POST /api/repos': async ({ body }) => {
    const dir = resolve(String(body.path).replace(/^~(?=$|\/)/, homedir()))
    let path = await G.isRepo(dir)
    if (!path && body.init) path = await initRepo(dir)
    if (!path) throw fail('errors.notRepo')
    const existing = state.repos.find(r => r.path === path)
    if (existing) return existing
    const repo = { id: newId(), path, name: basename(path), base: await G.defaultBranch(path) }
    state.repos.push(repo); save(); changed(); scanLogo(repo)
    return repo
  },
  'PATCH /api/repos/:id': ({ repo, body }) => { if (body.base) repo.base = body.base; save(); changed(); return repo },
  'DELETE /api/repos/:id': ({ repo }) => {
    if (state.workspaces.some(w => w.repoId === repo.id && !w.archived)) throw fail('errors.archiveWorkspacesFirst')
    state.repos = state.repos.filter(r => r !== repo); save(); changed(); return {}
  },
  'GET /api/repos/:id/branches': ({ repo }) => G.branches(repo.path),
  'POST /api/workspaces': async ctx => {
    const repo = state.repos.find(r => r.id === ctx.body.repoId)
    if (!repo) throw fail('errors.unknownRepo') // no click asked for what can't run
    // The label says what will be made: the name createWorkspace picks, and the base when it isn't the repo's.
    // ponytail: a name taken between the question and the click still gets its -v2 then.
    const base = ctx.body.base && ctx.body.base !== repo.base ? String(ctx.body.base) : null
    const vars = { repo: repo.name, name: await freeName(repo, ctx.body.name), ...base && { base } }, on = base ? '_base' : ''
    if (ctx.body.brief == null) return guard(ctx, 'confirm.create' + on, vars, () => createWorkspace(ctx.body))
    const b = validBrief(ctx.body.brief) // refused at once, before any click
    // One confirmation for the creation and its brief. A brief that can't be given leaves the workspace, said so.
    return guard(ctx, 'confirm.createBrief' + on, { ...vars, text: await briefLabel(null, b, repo.id) }, async () => {
      const ws = await createWorkspace(ctx.body)
      const q = await giveBrief(ws, b).catch(e => { throw failNested('confirm.createdNoBrief', { name: ws.name, reason: e.key ? { key: e.key, vars: e.vars } : e.message }, { ws }) })
      return q ? { ...ws, ...q } : ws
    })
  },
  'POST /api/workspaces/:id/brief': async ctx => {
    const b = validBrief(ctx.body)
    return guard(ctx, 'confirm.brief', { name: ctx.ws.title || ctx.ws.name, text: await briefLabel(ctx.ws, b) }, async () => (await giveBrief(ctx.ws, b)) ?? {})
  },
  'POST /api/sessions': createSession,
  'GET /api/workspaces/:id/log': ({ ws }) => readLog(ws.id),
  // checkFresh: the saved check ran on exactly these files, with the check as it is now (the page shows « out of date » otherwise).
  'GET /api/workspaces/:id/diff': async ({ ws }) => ({ diff: (await G.diff(ws.path, ws.baseRef || ws.base)).slice(0, 3_000_000), status: await G.status(ws.path),
    checkFresh: Rv.fresh(ws.check, (await G.snapshot(ws.path)).tree, !ws.free && config(ws).check) }),
  'PATCH /api/workspaces/:id': ({ ws, body }) => {
    // Rename. Empty: back to the city name, and the next message names it again.
    if (typeof body.title === 'string') ws.title = body.title.replace(/\s+/g, ' ').trim().slice(0, 80)
    A.configure(ws, body); changed(); return {}
  },
  'POST /api/workspaces/:id/upload': ({ ws, req, query }) => upload(ws, query.get('name'), req),
  // The page asks before queueing (errors.wouldQueue), then says force (send now) or queue; the aiguilleur's sends just queue.
  'POST /api/workspaces/:id/send': async ({ ws, body, caller }) =>
    (await sendTo(ws, String(body.text ?? ''), attached(ws, body.files), {}, caller === 'page' ? body.force ? 'force' : body.queue ? 'queue' : 'ask' : 'queue')) ?? {},
  // The page's Cancel on a queued message (never sent, then). Not the aiguilleur's: not on its list.
  'DELETE /api/workspaces/:id/queued/:item': ({ ws, item }) => {
    const i = ws.queued?.findIndex(q => q.id === item) ?? -1
    if (i < 0) throw fail('errors.notFound') // sent meanwhile
    ws.queued.splice(i, 1); save(); changed(); return {}
  },
  'GET /api/workspaces/:id/commands': ({ ws }) => A.commands(ws),
  // Commands with a full-screen UI (/permissions, /resume, /memory…) don't exist in -p mode: run them in the real,
  // interactive Claude Code, on this same conversation, in the Terminal tab. The idle chat process steps aside.
  'POST /api/workspaces/:id/terminal-command': ({ ws, body }) => {
    const command = String(body.command ?? '')
    if (!/^\/[\w:.-]+$/.test(command)) throw fail('errors.badCommand')
    if (A.runtime(ws.id).busy) throw fail('errors.agentBusy')
    A.stop(ws)
    const q = s => `'${s.replace(/'/g, `'\\''`)}'`
    openTerm(ws.id + ':claude', ws, [q(CLAUDE()), ...(ws.sessionId ? ['--resume', q(ws.sessionId)] : []), q(command)].join(' '), 'claude')
    return {}
  },
  'POST /api/workspaces/:id/interrupt': ({ ws }) => { A.interrupt(ws); return {} },
  'POST /api/workspaces/:id/stop-task': ({ ws, body }) => { A.stopTask(ws, String(body.id)); return {} },
  'POST /api/workspaces/:id/permission': ({ ws, body }) => { A.answer(ws, body.id, !!body.allow, body.message && String(body.message)); return {} },
  // The files went back: a stored check no longer says anything about them (the board's 🧪❌).
  'POST /api/workspaces/:id/revert': async ({ ws, body }) => { const r = await A.revert(ws, body.msgId); ws.checkStale = true; save(); return r },
  'POST /api/workspaces/:id/archive': ctx => guard(ctx, 'confirm.archive', { name: ctx.ws.title || ctx.ws.name }, async () => { await archive(ctx.ws); return {} }),
  'POST /api/workspaces/:id/unarchive': async ({ ws }) => { await unarchive(ws); return {} },
  'DELETE /api/workspaces/:id': ctx => guard(ctx, 'confirm.delete', { name: ctx.ws.title || ctx.ws.name }, async () => {
    const { ws } = ctx
    if (!ws.archived) await archive(ws)
    if (ws.free) rmSync(ws.path, { recursive: true, force: true })
    else {
      const repo = state.repos.find(r => r.id === ws.repoId)
      await G.git(repo.path, ['branch', '-D', ws.branch]).catch(() => {})
      await G.dropRefs(repo.path, `refs/aiguillage/${ws.id}/`).catch(() => {})
    }
    rmSync(attachDir(ws.id), { recursive: true, force: true })
    state.workspaces = state.workspaces.filter(w => w !== ws); save(); changed(); return {}
  }),
  'GET /api/workspaces/:id/scripts': ({ ws }) => { const c = config(ws); return { run: c.run, default: defaultRun(c), check: !!c.check } },
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
  'POST /api/workspaces/:id/commit': ctx => {
    const { ws } = ctx, message = String(ctx.body.message || `aiguillage: ${ws.name}`)
    return guard(ctx, 'confirm.commit', { name: ws.title || ws.name, message }, async () => {
      await G.git(ws.path, ['add', '-A'])
      await G.git(ws.path, ['commit', '-m', message])
      return notice('messages.committed')
    })
  },
  'POST /api/workspaces/:id/merge': async ctx => {
    // The page: refused now unless it sends force. The aiguilleur never picks force: the user's click does, on a label
    // that says the check isn't green; it is forced only if it wasn't green when asked (the body kept for the click says
    // so; at the click the route runs again with it: stale meanwhile is refused).
    const { ws } = ctx, aig = ctx.caller === 'aiguilleur' && !ctx.confirmed
    // Uncommitted changes first: no « merge anyway? » about a check for what can't merge at all.
    if (await G.status(ws.path)) throw fail('errors.uncommittedWorkspace')
    const forced = await gate(ws, aig ? { force: true } : ctx.body)
    return guard({ ...ctx, body: aig ? { force: !!forced } : ctx.body }, 'confirm.merge' + (forced ? '_' + forced : ''), { branch: ws.branch, base: ws.base }, async () => {
      try { const r = await merge(ws); metric('merge', { ws: ws.id, ok: true, conflict: false, ...forced && { forced: true } }); return r }
      catch (e) { metric('merge', { ws: ws.id, ok: false, conflict: e.key === 'errors.mergeConflict' }); throw e }
    })
  },
  'POST /api/workspaces/:id/check': ({ ws }) => {
    const command = !ws.free && config(ws).check
    if (!command) throw fail('errors.noCheck')
    return Rv.runSaved(ws, command)
  },
  'POST /api/workspaces/:id/pr': ctx => { const { ws } = ctx; return guard(ctx, 'confirm.pr', { branch: ws.branch, base: ws.base }, async () => {
    try {
      await G.git(ws.path, ['push', '-u', 'origin', ws.branch])
      const { stdout } = await exec('gh', ['pr', 'create', '--fill', '--head', ws.branch, '--base', ws.base], { cwd: ws.path })
      metric('pr', { ws: ws.id, ok: true })
      return { message: stdout.trim() }
    } catch (e) { metric('pr', { ws: ws.id, ok: false }); throw e }
  }) },
  'POST /api/workspaces/:id/open': ({ ws, body }) => {
    const cmd = body.app === 'code' ? ['code', [ws.path]] : [platform() === 'darwin' ? 'open' : 'xdg-open', [ws.path]]
    spawn(...cmd, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return {}
  },
}

// What the aiguilleur asks that can't be undone (creating a workspace, commit, merge, PR, archive, delete) waits for the
// user's click, in the window or on Telegram (lib/agent.js confirm); the outcome comes back as a report. The page acts at once.
// Kept as data in state.json (never a closure): the route, its :id and body. The click runs the route again with them
// (decide), so it checks the workspace as it is then; a restart asks again (startup below).
function guard(ctx, key, vars, run) {
  if (ctx.caller !== 'aiguilleur' || ctx.confirmed) return run()
  const c = { id: newId(), wsId: state.aiguilleur.id, routeKey: ctx.route, params: { id: ctx.id }, body: ctx.body, key, vars, at: Date.now(),
    telegram: R.fromTelegram() } // asked in a turn from Telegram: its buttons go there, even out of remote mode
  ;(state.confirms ??= []).push(c); save()
  register(c)
  return { pending: c.id, ...notice('confirm.waiting') }
}
const register = c => A.confirm(state.aiguilleur, { id: c.id, label: R.tr(c, 'en'), key: c.key, vars: c.vars, about: c.params.id, telegram: c.telegram }, allow => decide(c, allow))
async function decide(c, allow) {
  state.confirms = state.confirms.filter(x => x !== c); save()
  const asked = { key: c.key, vars: c.vars }, at = c.params.id && state.workspaces.find(w => w.id === c.params.id)
  // No workspace (a creation refused or failed, one deleted meanwhile): the report is the aiguilleur's own, titled with the request.
  // said: { key, vars } (Aiguillage's words, translated when shown) or { text } (git's, gh's).
  const tell = (ok, said, ws = at) => R.report(ws || state.aiguilleur, { ok, ...said, title: ws ? undefined : asked, action: true })
  if (!allow) return tell(false, { key: 'confirm.denied', vars: { action: asked } })
  try {
    const ctx = { body: c.body, caller: 'aiguilleur', confirmed: true, query: new URLSearchParams(), route: c.routeKey }
    bind(ctx, c.routeKey, c.params.id) // gone meanwhile: errors.notFound
    const out = await routes[c.routeKey](ctx)
    // A creation answers the new workspace; a brief may have joined the queue (sendTo), which the aiguilleur is told.
    tell(true, { ...out?.key ? { key: out.key, vars: out.vars } : out?.message ? { text: out.message } : asked, ...out?.queued === true && { queued: out.reason } }, at || out)
  } catch (e) { tell(false, e.key ? { key: e.key, vars: e.vars } : { text: (e.stderr || e.message || String(e)).trim() }, e.ws ?? at) }
}
// An error whose vars hold texts of their own ({ key, vars }), translated when shown; the English for logs and API callers.
const failNested = (key, vars, extra) => Object.assign(new Error(R.tr({ key, vars }, 'en')), { key, vars, ...extra })

// What the user sees when the aiguilleur hands a brief over (one place: overlap warnings are appended here), as lines
// translated when shown (R.tr): a heading, the brief as the agent will read it (English), then the warnings.
// The warning: another workspace of the repo already changed files in this brief's scope.
async function briefLabel(ws, b, repoId = ws.repoId) {
  const warn = []
  for (const o of activeIn(repoId, ws)) {
    const files = Rv.inScope(await mine(o), b.scope)
    if (files.length) warn.push({ key: 'overlap.brief', vars: { who: R.label(o), files: files.join(', ') } })
  }
  return [{ key: 'confirm.briefSent' }, briefText(b), ...warn]
}
// The brief reaches the agent as its task and stays on the workspace (shown on the page): kept only once sent or
// queued, never one the agent didn't get.
async function giveBrief(ws, b) {
  const q = await sendTo(ws, briefText(b)) // { queued, reason } when it waits
  ws.task = { ...b, at: Date.now() }
  save(); changed()
  metric('brief', { ws: ws.id, criteria: b.done.length })
  return q
}

// The chat's send, and Telegram's (lib/remote.js). The aiguilleur's model also reads the agents' reports it hasn't seen.
// A message that would put one more worker to work waits in ws.queued (saved) while too many work or the plan's
// session is nearly used up; one to a worker already at work folds into its turn, as always. -> { queued, reason } | undefined
// hold: 'queue' (as said), 'ask' (refuse with errors.wouldQueue instead), 'force' (send now whatever the load).
// ponytail: a forced message goes ahead of what already waited for this workspace; those follow it into its turn (drain).
async function sendTo(ws, text, files = [], opts = {}, hold = 'queue') {
  if (!text.trim() && !files.length) throw fail('errors.emptyMessage')
  // Two CLIs writing the same session would fork it: the chat waits for the terminal one to quit.
  if (terms.get(ws.id + ':claude')?.alive) throw fail('errors.claudeInTerminal')
  const idle = hold !== 'force' && ws !== state.aiguilleur && !A.working(A.runtime(ws.id)) && !starting.has(ws.id), now = idle && held()
  if (now && hold === 'ask') throw fail('errors.wouldQueue', { reason: now, ...load() })
  // Behind what already waits for this workspace, for the same reason: messages keep their order. Nothing holds it but
  // them: no question, it joins them and drain() sends them all if it can.
  const reason = now || idle && ws.queued?.length && reasonOf(ws.queued.at(-1))
  if (reason) {
    (ws.queued ??= []).push({ id: newId(), text, files, opts, reason, at: Date.now() })
    save(); changed()
    metric('queue', { ws: ws.id, reason })
    if (!now) drain()
    return { queued: true, reason }
  }
  await deliver(ws, text, files, opts)
}
// Why a new worker can't start now: 'cap' (maxAgents at work, Settings), 'quota' (the plan's session), or null.
// starting: workers between this check and A.send marking them busy (checkpoint first), so two sends at once can't both pass.
// A session limit past its reset time is stale: it no longer holds anything.
const starting = new Set()
const load = () => ({ working: state.workspaces.filter(w => starting.has(w.id) || A.working(A.runtime(w.id))).length, max: state.defaults?.maxAgents ?? MAX_AGENTS_DEFAULT,
  pct: A.usageNow()?.limits.find(l => l.kind === 'session' && !(l.resetsAt < Date.now()))?.pct ?? 0 })
function held() {
  const l = load()
  return l.working >= l.max ? 'cap' : l.pct >= QUOTA_HOLD_PCT ? 'quota' : null
}
// A queued item saved without a reason (an older version) waited for the cap: it keeps its place as such.
const reasonOf = q => q.reason ?? 'cap'
// Sends the queued messages whose turn has come, oldest first: a workspace's all at once (the first starts its turn,
// the others fold into it). Called on every state change (changed() below: turn ends, usage refreshes, Settings) and at startup.
// ponytail: an item leaves the queue before it is sent: a crash meanwhile loses it rather than sending it twice.
// Until the first usage probe ends (lib/agent.js usageKnown, 30 s at most), what waited for the quota stays: after a
// restart it would otherwise go out before the quota is known. What waited for the cap goes under the cap rule.
let draining = false
async function drain() {
  if (draining) return
  draining = true
  try {
    for (;;) {
      const free = !held()
      const ws = state.workspaces.filter(w => w.queued?.length && !w.archived && !terms.get(w.id + ':claude')?.alive
        && (A.working(A.runtime(w.id)) || free && (A.usageKnown() || reasonOf(w.queued[0]) !== 'quota')))
        .sort((a, b) => a.queued[0].at - b.queued[0].at)[0]
      if (!ws) return
      while (ws.queued.length) {
        const q = ws.queued.shift(); save(); changed()
        await deliver(ws, q.text, q.files, q.opts).catch(e => R.report(ws, e.key ? { ok: false, key: e.key, vars: e.vars } : { ok: false, text: e.message }))
      }
    }
  } finally { draining = false }
}
async function deliver(ws, text, files, opts) {
  if (ws !== state.aiguilleur) starting.add(ws.id) // synchronously, before the first await
  try { await sendNow(ws, text, files, opts) } finally { starting.delete(ws.id) }
}
async function sendNow(ws, text, files, opts) {
  if (ws === state.aiguilleur && !A.working(A.runtime(ws.id)) && R.stale(readLog(ws.id), ws.context)) A.forget(ws)
  // A worker hears what merged meanwhile along with this message (no turn of its own); forgotten only once sent.
  // Not on a slash command (it must still start with '/'): they wait for the next plain message.
  const notes = ws !== state.aiguilleur && ws.notices?.length && !text.trimStart().startsWith('/') ? [...ws.notices] : null
  await A.send(ws, text, files, ws === state.aiguilleur ? { via: opts.via, prompt: t => R.prompt(t, opts) } : notes ? { prompt: t => notes.join('\n\n') + '\n\n---\n\n' + t } : {})
  if (notes) { ws.notices = ws.notices.filter(n => !notes.includes(n)); save() }
}

const AIGUILLEUR_ROUTES = new Set(['GET /api/workspaces/:id/log', 'GET /api/workspaces/:id/commands', 'PATCH /api/workspaces/:id',
  ...['send', 'brief', 'upload', 'interrupt', 'stop-task', 'permission'].map(a => `POST /api/workspaces/:id/${a}`)])

// What the aiguilleur may call; anything else answers 403 (permission answers, modes, revert, Settings, Telegram…).
// Irreversible ones wait for the user's click (guard()). A rename only: model, effort and mode are the user's.
const FOR_AIGUILLEUR = new Set(['GET /api/state', 'GET /api/metrics', 'POST /api/workspaces', 'DELETE /api/workspaces/:id', 'PATCH /api/workspaces/:id',
  ...['log', 'diff', 'commands', 'scripts'].map(a => `GET /api/workspaces/:id/${a}`),
  ...['send', 'upload', 'interrupt', 'stop-task', 'check', 'brief', 'commit', 'merge', 'pr', 'archive'].map(a => `POST /api/workspaces/:id/${a}`)])
const forAiguilleur = (key, { ws, body }) => FOR_AIGUILLEUR.has(key)
  && !(key === 'PATCH /api/workspaces/:id' && ['model', 'effort', 'permissionMode'].some(k => body?.[k] !== undefined))
  && !(key === 'POST /api/workspaces/:id/brief' && ws === state.aiguilleur)

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

// Who calls /api: the aiguilleur (its token), the page (same-origin headers), or nobody we know.
// ponytail: a local program can forge sec-fetch-site: this stops an agent or an injected prompt from driving the API,
// not a hostile program under your account (the shell is not sandboxed, docs/DNA.md).
const caller = req => {
  const got = Buffer.from(req.headers.authorization ?? ''), want = Buffer.from('Bearer ' + TOKEN)
  if (got.length === want.length && timingSafeEqual(got, want)) return 'aiguilleur'
  return req.headers['sec-fetch-site'] === 'same-origin' || req.headers.origin === `http://${req.headers.host}` ? 'page' : null
}

// The workspace or repo a route's :id names, on ctx (a confirmed request is bound again at the click: decide()).
function bind(ctx, key, id) {
  if (!id) return
  if (id === 'aiguilleur') {
    // Not a worktree (lib/remote.js): only the chat routes apply to it.
    if (!AIGUILLEUR_ROUTES.has(key)) throw fail('errors.notFound')
    ctx.ws = state.aiguilleur
    return
  }
  ctx.ws = state.workspaces.find(w => w.id === id)
  ctx.repo = state.repos.find(r => r.id === id)
  if (!ctx[key.includes(' /api/repos/') ? 'repo' : 'ws']) throw fail('errors.notFound')
}

const refuse = (res, status, k) => { const { message: error, key } = notice(k); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error, key })) }

const server = http.createServer(async (req, res) => {
  if (!sameOrigin(req)) { res.writeHead(403); return res.end('forbidden') }
  const url = new URL(req.url, 'http://x')
  if (!url.pathname.startsWith('/api/')) {
    try { return url.pathname.startsWith('/attachments/') ? serveAttachment(url.pathname, res) : url.pathname === '/media' ? serveMedia(url.searchParams, req, res) : url.pathname.startsWith('/logo/') ? serveLogo(url.pathname, res) : serveStatic(url.pathname, res) } catch { res.writeHead(500); return res.end() }
  }
  const who = caller(req)
  if (!who) return refuse(res, 401, 'errors.unauthorized')
  const parts = url.pathname.split('/') // ['', 'api', kind, id, action, item]
  const key = `${req.method} ${parts.length > 3 ? ['', 'api', parts[2], ':id', ...parts.slice(4, 5), ...parts.slice(5).map(() => ':item')].join('/') : url.pathname}`
  if (who === 'aiguilleur') res.on('finish', () => metric('api', { route: key, status: res.statusCode })) // every exit: 404, 413, 415…
  // Uploads are the one raw body: still not a type a cross-site form can send without a preflight.
  const raw = key === 'POST /api/workspaces/:id/upload'
  if (req.method !== 'GET' && req.headers['content-type'] !== (raw ? 'application/octet-stream' : 'application/json')) { res.writeHead(415); return res.end() }
  const route = routes[key]
  if (!route) { res.writeHead(404); return res.end() }
  // Too big: answer 413 and close right away (an unread body would otherwise keep the client hanging).
  const tooBig = () => {
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ error: 'Request too large.', key: 'errors.tooLarge' }), () => req.destroy())
  }
  if (Number(req.headers['content-length']) > (raw ? MAX_UPLOAD : 1e6)) return tooBig()
  try {
    let json = ''
    if (!raw) for await (const c of req) { json += c; if (json.length > 1e6) return tooBig() }
    const ctx = { body: json ? JSON.parse(json) : {}, req, query: url.searchParams, caller: who, route: key, id: parts[3], item: parts[5] && decodeURIComponent(parts[5]) }
    bind(ctx, key, parts[3])
    if (who === 'aiguilleur' && !forAiguilleur(key, ctx)) return refuse(res, 403, 'errors.notForAiguilleur')
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
// Desktop app updates. Before the restart, running scripts are noted so they start again after it;
// conversations need nothing: they resume with --resume, and the UI reopens the same workspace and tab.
if (process.versions.electron) U.start({
  changed,
  enabled: () => state.defaults?.autoUpdate !== false,
  busy: () => [...state.workspaces, state.aiguilleur].filter(w => w && A.working(A.runtime(w.id))).length,
  beforeInstall: () => {
    state.resumeScripts = state.workspaces.filter(w => terms.get(w.id + ':script')?.alive).map(w => ({ ws: w.id, id: terms.get(w.id + ':script').label }))
    save()
  },
})
for (const r of state.resumeScripts ?? []) {
  const ws = state.workspaces.find(w => w.id === r.ws && !w.archived), run = ws && existsSync(ws.path) && config(ws).run[r.id]
  if (run) openTerm(ws.id + ':script', ws, run.command, r.id)
}
if (state.resumeScripts) { delete state.resumeScripts; save() }

// Logs written before lib/agent.js trim() still hold screenshots and thinking: cut them once, like new ones.
if (!state.logsTrimmed) {
  for (const w of state.workspaces) { const log = readLog(w.id); if (log.length) writeLog(w.id, log.map(e => Array.isArray(e.message?.content) ? { ...e, message: { ...e.message, content: A.trim(e.message.content) } } : e)) }
  state.logsTrimmed = true; save()
}

for (const r of state.repos) scanLogo(r)

// The aiguilleur, and Telegram once set up in Settings (lib/remote.js).
R.start({ port: PORT, changed, afterTurn: scanOverlaps, send: (ws, text, paths, opts) => sendTo(ws, text, attached(ws, paths), opts) })
for (const w of state.workspaces) for (const q of w.queued ?? []) q.id ??= newId() // queued before ids: the page cancels by id
// What waited for the user's click before the restart is asked again; a day old, dropped (one report says which).
{
  const old = (state.confirms ?? []).filter(c => !(Date.now() - c.at < CONFIRM_TTL))
  state.confirms = (state.confirms ?? []).filter(c => !old.includes(c))
  for (const c of state.confirms) register(c)
  if (old.length) R.report(state.aiguilleur, { ok: false, title: { key: 'confirm.expiredTitle' }, key: 'confirm.expired', vars: { count: old.length, list: old.map(c => ({ key: c.key, vars: c.vars })) } })
  save()
}
drain() // what was queued before a restart

// Plan usage in the sidebar: now, every 3 min, and after each agent turn (lib/agent.js).
A.refreshUsage(); setInterval(A.refreshUsage, 3 * 60_000).unref()

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
  Rv.killChecks() // a check is detached (its own process group): it would outlive the app
  for (const w of state.workspaces) A.stop(w)
  if (state.aiguilleur) A.stop(state.aiguilleur)
  for (const t of terms.values()) if (t.alive) t.p.kill()
}
process.on('uncaughtException', e => console.error('[aiguillage]', e))
process.on('unhandledRejection', e => console.error('[aiguillage]', e))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(0) })
