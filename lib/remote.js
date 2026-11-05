// The aiguilleur, and Telegram to drive Aiguillage from your phone while the Mac runs at home.
// The aiguilleur is a Claude Code agent of its own (pinned at the top of the sidebar) that sees every repo and
// workspace, reports, and relays the user's instructions to the agents through this server's own HTTP API. It keeps
// what it learns about the projects in its folder, ~/.aiguillage/aiguilleur (CLAUDE.md + projects/*.md); after each
// agent turn, a quick Haiku call adds what's worth remembering to that project's journal (remember() below).
// Telegram is set up in Settings (connect()): a bot token, then a one-time t.me link that ties the user's chat to it.
// Outbound only: the bot long-polls Telegram, nothing listens on the network. Only the linked chat is obeyed.
// The aiguilleur is the user's one interlocutor, in the window and on Telegram: a single conversation, mirrored.
// - Each agent's finished turn (its last words) is a report in the aiguilleur's conversation; the aiguilleur's model
//   reads those it hasn't seen at the top of the user's next message (prompt()).
// - Whatever the user writes on Telegram goes to the aiguilleur, which relays; a reply to a report says which agent.
// Remote mode (the sidebar button, /remote and /local) decides whether Telegram is pushed anything: the whole
// conversation (reports, what the user types at the Mac, the aiguilleur's answers) and the permission requests and
// plans, with Allow / Deny buttons. Turning it on catches up: where every workspace stands, the reports missed
// meanwhile, the requests still waiting. Off, the linked chat can still write, and gets the answers to that.
import { readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { state, save, readLog, HOME } from './store.js'
import * as A from './agent.js'
import { i18n, fail } from './i18n.js'

// One Telegram update -> what to do. sent: Telegram message id -> workspace id it reports on.
// code: while no chat is linked, the one-time code of the Settings link (t.me/<bot>?start=<code> sends « /start <code> »).
export function route(u, chat, sent, code) {
  const q = u.callback_query
  if (q) {
    if (chat == null || q.message?.chat?.id !== chat) return null
    const [k, ws, allow, ...id] = String(q.data ?? '').split(':')
    return k === 'p' ? { kind: 'perm', ws, allow: allow === '1', id: id.join(':'), query: q.id, msg: q.message.message_id } : null
  }
  const m = u.message
  if (!m?.text) return null
  if (m.chat.id !== chat) {
    if (chat != null) return null
    return code && m.text.trim() === `/start ${code}` ? { kind: 'link', chat: m.chat.id, name: m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '' }
      : { kind: 'pair', chat: m.chat.id }
  }
  const text = m.text.trim(), cmd = text.split(/[\s@]/)[0]
  const reply = m.reply_to_message, ws = reply && sent.get(reply.message_id)
  if (cmd === '/stop') return { kind: 'stop', ws: ws ?? 'aiguilleur' }
  if (!reply && ['/status', '/remote', '/local', '/start'].includes(cmd)) return { kind: cmd.slice(1) }
  // Everything else is for the aiguilleur. A reply to an agent's report or request says which workspace it is about.
  if (ws && ws !== 'aiguilleur') return { kind: 'send', about: ws, text }
  // A reply to a message we no longer map (sent before a restart): the aiguilleur gets the quote and sorts it out.
  return { kind: 'send', text: reply?.text && !ws ? `> ${reply.text.slice(0, 600).replace(/\n/g, '\n> ')}\n\n${text}` : text }
}

export function brief(port) {
  const api = `http://127.0.0.1:${port}`
  return [
    "You are the aiguilleur (the switchman who sets the points) of Aiguillage, a local app on the user's Mac that runs several Claude Code agents in parallel, one per git worktree (a \"workspace\").",
    "The user talks to you from Aiguillage's window or, when away, from Telegram (their message then starts with [Telegram]): one conversation, shown on both sides. Be brief, in the user's language; plain text that reads well on a phone screen: no tables, no headings.",
    "You are the user's one interlocutor: the agents report to you and the user answers through you.",
    'Your role is to report and to relay, never to decide. The user makes every decision and gives every instruction:',
    "- You report: what each agent is doing, has done, is stuck on or asks. Facts, not advice, unless the user asks for your opinion.",
    "- You relay: when the user tells you to give an agent an instruction, send it what the user said, faithfully (their intent, their words where possible). Add only the context the agent needs to understand it; never add tasks, steps or choices of your own.",
    '- Nothing on your own initiative: no message to an agent, no new workspace, no interrupt, commit, merge or PR unless the user asked for that very action in their message. An agent asking a question or waiting for a choice is something you report to the user, not something you answer.',
    "- Unsure which workspace they mean or what exactly to send? Ask the user; don't guess.",
    `You don't write code. You read and act through Aiguillage's HTTP API at ${api} (curl; POST bodies are JSON, with -H 'content-type: application/json'):`,
    '- GET /api/state: repos, and workspaces (id, repoId, name, title, branch, path, busy, failed, pending permission requests, archived). Ignore archived ones.',
    '- GET /api/workspaces/<id>/log: its conversation as a JSON array, often long: pipe it through python3 or jq and keep the last entries (cg_user = what the user said, assistant = the agent).',
    '- GET /api/workspaces/<id>/diff: its changes against its base branch.',
    '- POST /api/workspaces/<id>/send {"text": "..."}: relay the user\'s instruction to that agent. When it finishes its turn, Aiguillage shows its report to the user in this conversation (and on Telegram) by itself: no need to wait for it or pass it on.',
    '- When the user asks for it: POST /api/workspaces/<id>/interrupt; POST /api/workspaces {"repoId": "...", "name": "short-slug"} (a new workspace, then relay their task to it); /commit {"message": "..."}, /merge, /pr.',
    'Permission requests are not yours to answer: the user gets Allow / Deny buttons for them, in Aiguillage and on Telegram.',
    'The repos are on disk (paths in /api/state): read them freely to answer questions about the projects, but never edit them.',
    'Your memory is the folder you run in, the only place you may write:',
    "- CLAUDE.md, loaded at the start of each of your sessions: a short index. The user's standing preferences about how you work, then one line per project (repo name, path, what it is) pointing to its notes.",
    "- projects/<repo name>.md: what you know about a project: purpose, stack, layout, how to run and test it, conventions, the work in progress, and the decisions the user took (with dates). Build a project's file the first time you need it (its README, CLAUDE.md, manifest, recent git log), read it before answering about that project, and update it when you learn something durable, from the repo, an agent's work or the user.",
    "- Its last section, ## Journal, is appended by Aiguillage after each agent turn (dated lines). Keep it last; fold what lasts into the sections above and trim the journal as it grows.",
    '- Facts only, short, dated when they can go stale; drop what is outdated. Never store secrets. Writing your notes is the one thing you do without being asked.',
    "Agents' reports (their last words when they finish a turn, marked ✅ or ❌ with the project and workspace) are shown to the user as they come. Those you haven't read yet head the user's next message, under [Reports from the agents since your last message]: take them in to know where things stand; don't repeat them unless asked.",
    "A message with [Reply to the report of <project> / <workspace> (id <id>)] is the user answering that agent: relay it to that workspace, faithfully, unless it is clearly a question for you.",
  ].join('\n')
}

let send = null, changed = () => {}
const sent = new Map()
const asked = new Set() // permission requests already posted
const last = new Map() // workspace id -> its last words this turn
let aiguilleur = null
const viaTelegram = new Set() // the aiguilleur's turns asked from Telegram: answered there even out of remote mode
// { token, bot, chat, chatName, code, remote, offset, lang }, in state.json: never sent to the page (info() below).
const tg = () => (state.telegram ??= { offset: 0 })
const linked = () => !!tg().token && tg().chat != null
const remote = () => linked() && !!tg().remote
const missed = new Map() // workspace id -> its last report while remote mode was off
const t = (key, vars) => i18n.t(key, { lng: tg().lang, ...vars })
let ctl = new AbortController(), gen = 0, lastError = null, awake = null

async function call(method, body, token = tg().token) {
  const r = await fetch(`${process.env.AIGUILLAGE_TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(70_000)]) })
  const j = await r.json()
  if (!j.ok) throw new Error(`${method}: ${j.description}`)
  return j.result
}
const log = e => console.error('[telegram]', e.message)

// What Settings shows.
export function info() {
  const { token, bot, chat, chatName, code } = tg()
  return { on: !!token, bot, linked: chat != null, remote: remote(), chatName, code: chat == null ? code : undefined,
    link: token && chat == null && bot && code ? `https://t.me/${bot}?start=${code}` : undefined, error: token ? lastError : undefined }
}

// From Settings: a new token (checked with getMe) starts over, waiting for the user's link; '' disconnects.
export async function connect(token) {
  token = String(token ?? '').trim()
  let bot
  if (token) bot = (await call('getMe', {}, token).catch(() => { throw fail('errors.telegramToken') })).username
  state.telegram = token ? { token, bot, chat: null, chatName: null, code: randomBytes(6).toString('hex'), offset: 0, lang: tg().lang } : { offset: 0, lang: tg().lang }
  lastError = null
  save(); restart(); changed()
}

async function tell(text, wsId, extra = {}) {
  if (!linked()) return
  const m = await call('sendMessage', { chat_id: tg().chat, text: text.slice(0, 4000) || '…', ...extra })
  if (wsId) { sent.set(m.message_id, wsId); if (sent.size > 1000) sent.delete(sent.keys().next().value) }
}

const find = id => id === 'aiguilleur' ? aiguilleur : state.workspaces.find(w => w.id === id && !w.archived)
// The project, then the workspace: its task's title and its name.
const label = ws => ws === aiguilleur ? '' : `${state.repos.find(r => r.id === ws.repoId)?.name ?? '?'} / ${ws.title && ws.title !== ws.name ? `${ws.title} (${ws.name})` : ws.name}`
const reportText = ev => [`${ev.ok ? '✅' : '❌'} ${ev.label}`, ev.text].filter(Boolean).join('\n\n')

// Every agent event (lib/agent.js record): keep what was asked and the agent's words. When a workspace's turn ends,
// note what's worth remembering and report it in the aiguilleur's conversation; that conversation goes to Telegram.
export function onEvent(m) {
  if (m.t !== 'ev' || !aiguilleur) return
  const ws = find(m.ws), ev = m.ev
  if (!ws) return
  if (ev.type === 'cg_user') asks.set(ws.id, ev.text)
  if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
    const text = (ev.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    if (text) last.set(ws.id, text)
  }
  if (ws === aiguilleur) return mirror(ev)
  if (ev.type !== 'result' && ev.type !== 'cg_error') return
  const ok = ev.type === 'result' && !ev.is_error
  const words = ev.type === 'cg_error' ? ev.text : ev.is_error ? ev.error ?? '' : last.get(ws.id) ?? ''
  last.delete(ws.id)
  if (ok) remember(ws, asks.get(ws.id) ?? '', words)
  A.record(aiguilleur, { type: 'cg_report', ws: ws.id, label: label(ws), ok, text: words, ts: Date.now() })
}

// The aiguilleur's conversation on Telegram: all of it in remote mode; otherwise only the answers to what was asked
// from there, and the reports wait for the catch-up (setRemote).
function mirror(ev) {
  if (!linked()) return
  if (ev.type === 'cg_report') return remote() ? tell(reportText(ev), ev.ws).catch(log) : missed.set(ev.ws, reportText(ev))
  if (ev.type === 'cg_user') return ev.via !== 'telegram' && remote() && tell(`${t('telegram.fromMac')}\n${ev.text}`).catch(log)
  if (ev.type !== 'result' && ev.type !== 'cg_error') return
  const words = ev.type === 'cg_error' ? ev.text : ev.is_error ? ev.error ?? '' : last.get(aiguilleur.id) ?? ''
  last.delete(aiguilleur.id)
  if (!viaTelegram.delete(aiguilleur.id) && !remote()) return
  tell([ev.is_error || ev.type === 'cg_error' ? '❌' : '', words].filter(Boolean).join('\n\n'), aiguilleur.id).catch(log)
}

// What the aiguilleur's model reads for a message of the user's: the reports logged since the user's last message
// (it hasn't seen them), then the message, with where it comes from. about: the workspace whose report it answers.
// ponytail: reads the whole log per message; cut each report and keep the latest, the full text is in the API.
const MAX_REPORTS = 30, MAX_REPORT = 2000
export function prompt(text, { via, about } = {}, log = readLog('aiguilleur')) {
  const reports = log.slice(log.findLastIndex(e => e.type === 'cg_user') + 1).filter(e => e.type === 'cg_report')
  const kept = reports.slice(-MAX_REPORTS).map(e => reportText({ ...e, text: e.text.length > MAX_REPORT ? e.text.slice(0, MAX_REPORT) + '…' : e.text }) + `\n(workspace id ${e.ws})`)
  const head = reports.length && ['[Reports from the agents since your last message]',
    reports.length > kept.length && `(${reports.length - kept.length} older ones left out: GET /api/workspaces/aiguilleur/log)`, ...kept].filter(Boolean).join('\n\n')
  const ws = about && find(about)
  const msg = [via === 'telegram' && '[Telegram]', ws && `[Reply to the report of ${label(ws)} (id ${ws.id})]`, text].filter(Boolean).join(' ')
  return [head, msg].filter(Boolean).join('\n\n---\n\n')
}

// Remote mode on/off, from the sidebar (server.js) or Telegram. On: catch up with everything, then push.
export async function setRemote(on) {
  if (!linked()) throw fail('errors.telegramNotLinked')
  tg().remote = !!on; save(); keepAwake(); changed()
  if (!on) return tell(t('telegram.remoteOff'))
  await tell(t('telegram.remoteOn') + '\n\n' + status())
  for (const [id, report] of missed) if (find(id)) await tell(report, id)
  missed.clear()
  asked.clear(); sync() // requests still waiting come again, with their buttons
}

// ---------- the aiguilleur's memory: each agent turn adds its durable facts to the project's journal ----------
const asks = new Map() // workspace id -> what the user last asked it
const writing = new Map() // notes file -> its last write: one at a time per file
export const notesFile = (dir, repo) => join(dir, 'projects', repo.name.replace(/[^\w.-]+/g, '-') + '.md')

// Model output -> journal lines: at most 5, none when it answers NOTHING.
export function journalLines(out) {
  const lines = out.split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()).filter(Boolean)
  return /^nothing\b/i.test(lines[0] ?? 'nothing') ? [] : lines.slice(0, 5)
}

// Same isolation as the workspace names (lib/agent.js nameFrom): no tools, hooks or MCP, outside every repo.
// ponytail: append-only, the aiguilleur tidies the notes when it reads them; a call per turn, Haiku keeps it cheap.
function remember(ws, ask, words) {
  const repo = state.repos.find(r => r.id === ws.repoId)
  if (!repo || !words) return
  const file = notesFile(aiguilleur.path, repo)
  const p = (writing.get(file) ?? Promise.resolve()).then(async () => {
    const notes = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const run = promisify(execFile)(A.CLAUDE(), ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--strict-mcp-config',
      '--disable-slash-commands', '--setting-sources', 'project', '--system-prompt', 'You keep the notebook of a software project.'],
    { cwd: tmpdir(), env: A.cleanEnv(), timeout: 120_000 })
    run.child.stdin.on('error', () => {})
    run.child.stdin.end([
      `An agent just finished a turn on the project "${repo.name}" (workspace ${ws.name}, branch ${ws.branch}).`,
      `What the user asked:\n${ask.slice(0, 3000)}`, `What the agent answered:\n${words.slice(0, 4000)}`,
      `The notes on the project so far:\n${notes.slice(-6000) || '(none)'}`,
      'List the facts from this turn worth remembering about the project: what was done or decided, what is in progress or blocked, how things work. One short line each, at most 5, in the language of the notes (or of the user). Skip what the notes already say, chit-chat and anything temporary; never secrets. If nothing is worth keeping, answer NOTHING.',
    ].join('\n\n'))
    const lines = journalLines((await run).stdout)
    if (!lines.length) return
    mkdirSync(dirname(file), { recursive: true })
    const head = !notes ? `# ${repo.name}\n\nPath: ${repo.path}\n\n## Journal\n` : (notes.endsWith('\n') ? '' : '\n') + (/^## Journal\b/m.test(notes) ? '' : '\n## Journal\n')
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(file, head + lines.map(l => `- ${day} (${ws.name}): ${l}\n`).join(''))
  }).catch(e => console.error('[notes]', e.message))
  writing.set(file, p)
}

// After each state change: post permission requests not posted yet.
export function sync() {
  if (!remote()) return
  for (const ws of [aiguilleur, ...state.workspaces]) for (const p of A.runtime(ws.id).pending) {
    if (asked.has(p.id)) continue
    asked.add(p.id)
    const what = p.tool === 'ExitPlanMode' ? t('perm.proposesPlan') + '\n\n' + (p.input.plan ?? '')
      : t('perm.wantsTool', { tool: p.tool }) + '\n\n' + (p.input.command ?? p.input.file_path ?? JSON.stringify(p.input, null, 1))
    const buttons = [[{ text: t('perm.allow'), callback_data: `p:${ws.id}:1:${p.id}` }, { text: t('perm.deny'), callback_data: `p:${ws.id}:0:${p.id}` }]]
    tell(`🔐 ${label(ws) || 'Aiguilleur'}\n${what.slice(0, 3500)}`, ws.id, { reply_markup: { inline_keyboard: buttons } }).catch(log)
  }
}

function status() {
  const lines = state.workspaces.filter(w => !w.archived).map(w => {
    const r = A.runtime(w.id)
    return `${r.pending.length ? '🔐' : A.working(r) ? '⏳' : r.failed ? '❌' : '💤'} ${label(w)}`
  })
  return lines.join('\n') || t('telegram.none')
}

async function handle(u) {
  const r = route(u, tg().chat ?? null, sent, tg().code)
  if (!r) return
  const from = u.message?.from ?? u.callback_query?.from
  if (from?.language_code && from.language_code !== tg().lang) { tg().lang = from.language_code; save() }
  if (r.kind === 'pair') return call('sendMessage', { chat_id: r.chat, text: t('telegram.pair') })
  if (r.kind === 'link') {
    Object.assign(tg(), { chat: r.chat, chatName: r.name, code: null }); save(); commands()
    await tell(t('telegram.linked'))
    return setRemote(true) // just set up from the phone: the user wants to see it work
  }
  if (r.kind === 'remote' || r.kind === 'local') return setRemote(r.kind === 'remote')
  if (r.kind === 'perm') {
    const ws = find(r.ws)
    if (ws) A.answer(ws, r.id, r.allow)
    await call('answerCallbackQuery', { callback_query_id: r.query, text: r.allow ? '✅' : '❌' })
    return call('editMessageReplyMarkup', { chat_id: tg().chat, message_id: r.msg, reply_markup: { inline_keyboard: [] } })
  }
  if (r.kind === 'status' || r.kind === 'start') return tell(status())
  const ws = find(r.kind === 'stop' ? r.ws : r.about ?? 'aiguilleur')
  if (!ws) return tell(t('telegram.gone'))
  if (r.kind === 'stop') return A.interrupt(ws)
  viaTelegram.add(aiguilleur.id); call('sendChatAction', { chat_id: tg().chat, action: 'typing' }).catch(() => {})
  await send(aiguilleur, r.text, [], { via: 'telegram', about: r.about }).catch(e => { viaTelegram.delete(aiguilleur.id); tell('⚠️ ' + e.message) })
}

// One poller per token: a new token (or none) aborts the running one.
function restart() {
  gen++; ctl.abort(); ctl = new AbortController()
  keepAwake()
  if (!tg().token) return
  if (linked()) commands()
  poll(gen)
}

// Remote mode is when the Mac runs on its own: no idle sleep meanwhile (closing the lid still sleeps).
function keepAwake() {
  if (!remote()) { awake?.kill(); awake = null; return }
  if (awake || process.platform !== 'darwin') return
  awake = spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {})
  awake.unref()
}

// The bot's command menu in Telegram, in the user's language.
const commands = () => call('setMyCommands', { commands: ['remote', 'local', 'status', 'stop'].map(c => ({ command: c, description: t(`telegram.cmd.${c}`) })) }).catch(log)
const failed = e => { if (lastError !== e) { lastError = e; changed() } }

async function poll(g) {
  while (g === gen) {
    try {
      const updates = await call('getUpdates', { offset: tg().offset, timeout: 50, allowed_updates: ['message', 'callback_query'] })
      if (g !== gen) return
      failed(null)
      for (const u of updates) {
        // Saved before handling: after a crash or restart, a message is never acted on twice.
        tg().offset = u.update_id + 1; save()
        await handle(u).catch(log)
      }
    } catch (e) {
      if (g !== gen) return
      log(e); failed(e.message)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// opts.send(ws, text, files, { via, about }): the chat's own send (same checks). port: this server's.
export function start({ port, send: sendFn, changed: changedFn }) {
  // A workspace of its own outside every repo, so it can't edit any project's files (lib/agent.js inside()).
  aiguilleur = state.aiguilleur ??= { id: 'aiguilleur', name: 'aiguilleur', title: 'Aiguilleur', branch: '', base: '', permissionMode: 'auto', model: '', effort: '' }
  Object.assign(aiguilleur, { path: join(HOME, 'aiguilleur'), port, brief: brief(port) })
  mkdirSync(aiguilleur.path, { recursive: true })
  save()
  send = sendFn; changed = changedFn ?? changed
  restart()
}
