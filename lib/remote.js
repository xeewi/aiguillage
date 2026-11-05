// The aiguilleur, and Telegram to drive Aiguillage from your phone while the Mac runs at home.
// The aiguilleur is a Claude Code agent of its own (pinned at the top of the sidebar) that sees every repo and
// workspace, reports, and relays the user's instructions to the agents through this server's own HTTP API. It keeps
// what it learns about the projects in its folder, ~/.aiguillage/aiguilleur (CLAUDE.md + projects/*.md); after each
// agent turn, a quick Haiku call adds what's worth remembering to that project's journal (remember() below).
// Telegram is off unless ~/.aiguillage/settings.toml has a [telegram] token. Outbound only: the bot long-polls Telegram, nothing
// listens on the network. Only the chat set in `chat` is obeyed; any other chat just gets told its id (to pair).
// - each agent's finished turn is reported (its last words); reply to that message to talk to that agent;
// - permission requests and plans come with Allow / Deny buttons;
// - anything else goes to the aiguilleur.
import { readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse } from 'smol-toml'
import { state, save, HOME } from './store.js'
import * as A from './agent.js'
import { i18n } from './i18n.js'

export function settings(home = HOME) {
  try {
    const t = parse(readFileSync(join(home, 'settings.toml'), 'utf8')).telegram
    return t?.token ? { token: String(t.token), chat: t.chat == null ? null : Number(t.chat) } : null
  } catch { return null }
}

// One Telegram update -> what to do. sent: Telegram message id -> workspace id it reports on.
export function route(u, chat, sent) {
  const q = u.callback_query
  if (q) {
    if (chat == null || q.message?.chat?.id !== chat) return null
    const [k, ws, allow, ...id] = String(q.data ?? '').split(':')
    return k === 'p' ? { kind: 'perm', ws, allow: allow === '1', id: id.join(':'), query: q.id, msg: q.message.message_id } : null
  }
  const m = u.message
  if (!m?.text) return null
  if (m.chat.id !== chat) return chat == null ? { kind: 'pair', chat: m.chat.id } : null
  const text = m.text.trim(), cmd = text.split(/[\s@]/)[0]
  const reply = m.reply_to_message, ws = reply && sent.get(reply.message_id)
  if (cmd === '/stop') return { kind: 'stop', ws: ws ?? 'aiguilleur' }
  if (!reply && ['/status', '/mute', '/unmute', '/start'].includes(cmd)) return { kind: cmd.slice(1) }
  if (ws) return { kind: 'send', ws, text }
  // A reply to a message we no longer map (sent before a restart): the aiguilleur gets the quote and sorts it out.
  return { kind: 'send', ws: 'aiguilleur', text: reply?.text ? `> ${reply.text.slice(0, 600).replace(/\n/g, '\n> ')}\n\n${text}` : text }
}

export function brief(port) {
  const api = `http://127.0.0.1:${port}`
  return [
    "You are the aiguilleur (the switchman who sets the points) of Aiguillage, a local app on the user's Mac that runs several Claude Code agents in parallel, one per git worktree (a \"workspace\").",
    "The user talks to you from Aiguillage's window or, when away, from Telegram (their message then says so). Be brief, in the user's language; on Telegram, plain text for a phone screen: no tables, no headings.",
    'Your role is to report and to relay, never to decide. The user makes every decision and gives every instruction:',
    "- You report: what each agent is doing, has done, is stuck on or asks. Facts, not advice, unless the user asks for your opinion.",
    "- You relay: when the user tells you to give an agent an instruction, send it what the user said, faithfully (their intent, their words where possible). Add only the context the agent needs to understand it; never add tasks, steps or choices of your own.",
    '- Nothing on your own initiative: no message to an agent, no new workspace, no interrupt, commit, merge or PR unless the user asked for that very action in their message. An agent asking a question or waiting for a choice is something you report to the user, not something you answer.',
    "- Unsure which workspace they mean or what exactly to send? Ask the user; don't guess.",
    `You don't write code. You read and act through Aiguillage's HTTP API at ${api} (curl; POST bodies are JSON, with -H 'content-type: application/json'):`,
    '- GET /api/state: repos, and workspaces (id, repoId, name, title, branch, path, busy, failed, pending permission requests, archived). Ignore archived ones.',
    '- GET /api/workspaces/<id>/log: its conversation as a JSON array, often long: pipe it through python3 or jq and keep the last entries (cg_user = what the user said, assistant = the agent).',
    '- GET /api/workspaces/<id>/diff: its changes against its base branch.',
    '- POST /api/workspaces/<id>/send {"text": "..."}: relay the user\'s instruction to that agent. It reports to the user on Telegram by itself when its turn ends: no need to wait or relay its answer.',
    '- When the user asks for it: POST /api/workspaces/<id>/interrupt; POST /api/workspaces {"repoId": "...", "name": "short-slug"} (a new workspace, then relay their task to it); /commit {"message": "..."}, /merge, /pr.',
    'Permission requests are not yours to answer: the user gets Allow / Deny buttons for them on Telegram.',
    'The repos are on disk (paths in /api/state): read them freely to answer questions about the projects, but never edit them.',
    'Your memory is the folder you run in, the only place you may write:',
    "- CLAUDE.md, loaded at the start of each of your sessions: a short index. The user's standing preferences about how you work, then one line per project (repo name, path, what it is) pointing to its notes.",
    "- projects/<repo name>.md: what you know about a project: purpose, stack, layout, how to run and test it, conventions, the work in progress, and the decisions the user took (with dates). Build a project's file the first time you need it (its README, CLAUDE.md, manifest, recent git log), read it before answering about that project, and update it when you learn something durable, from the repo, an agent's work or the user.",
    "- Its last section, ## Journal, is appended by Aiguillage after each agent turn (dated lines). Keep it last; fold what lasts into the sections above and trim the journal as it grows.",
    '- Facts only, short, dated when they can go stale; drop what is outdated. Never store secrets. Writing your notes is the one thing you do without being asked.',
    'Replies the user makes to an agent\'s Telegram report go straight to that agent, not to you.',
  ].join('\n')
}

let cfg = null, send = null
const sent = new Map()
const asked = new Set() // permission requests already posted
const last = new Map() // workspace id -> its last words this turn
let aiguilleur = null
const viaTelegram = new Set() // the aiguilleur's turns asked from Telegram: only their answers go back there
const tg = () => (state.telegram ??= { offset: 0 })
const t = (key, vars) => i18n.t(key, { lng: tg().lang, ...vars })

async function call(method, body) {
  const r = await fetch(`${process.env.AIGUILLAGE_TELEGRAM_API || 'https://api.telegram.org'}/bot${cfg.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(70_000) })
  const j = await r.json()
  if (!j.ok) throw new Error(`${method}: ${j.description}`)
  return j.result
}
const log = e => console.error('[telegram]', e.message)

async function tell(text, wsId, extra = {}) {
  if (cfg?.chat == null) return
  const m = await call('sendMessage', { chat_id: cfg.chat, text: text.slice(0, 4000) || '…', ...extra })
  if (wsId) { sent.set(m.message_id, wsId); if (sent.size > 1000) sent.delete(sent.keys().next().value) }
}

const find = id => id === 'aiguilleur' ? aiguilleur : state.workspaces.find(w => w.id === id && !w.archived)
const label = ws => ws === aiguilleur ? '' : `${state.repos.find(r => r.id === ws.repoId)?.name ?? '?'} / ${ws.title || ws.name}`

// Every agent event (lib/agent.js record): keep what was asked and the agent's words; when its turn ends, note
// what's worth remembering and report on Telegram.
export function onEvent(m) {
  if (m.t !== 'ev' || !aiguilleur) return
  const ws = find(m.ws), ev = m.ev
  if (!ws) return
  if (ev.type === 'cg_user') asks.set(ws.id, ev.text)
  if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
    const text = (ev.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    if (text) last.set(ws.id, text)
  }
  if (ev.type !== 'result' && ev.type !== 'cg_error') return
  const words = ev.type === 'cg_error' ? ev.text : ev.is_error ? ev.error ?? '' : last.get(ws.id) ?? ''
  last.delete(ws.id)
  if (ws !== aiguilleur && ev.type === 'result' && !ev.is_error) remember(ws, asks.get(ws.id) ?? '', words)
  if (!cfg) return
  if (ws === aiguilleur ? !viaTelegram.delete(ws.id) : tg().muted) return
  const head = ws === aiguilleur ? (ev.is_error || ev.type === 'cg_error' ? '❌' : '') : `${ev.is_error || ev.type === 'cg_error' ? '❌' : '✅'} ${label(ws)}`
  tell([head, words].filter(Boolean).join('\n\n'), ws.id).catch(log)
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
  if (!cfg || tg().muted) return
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
  const r = route(u, cfg.chat, sent)
  if (!r) return
  if (r.kind === 'pair') return call('sendMessage', { chat_id: r.chat, text: t('telegram.pair', { chat: r.chat }) })
  const from = u.message?.from ?? u.callback_query?.from
  if (from?.language_code && from.language_code !== tg().lang) { tg().lang = from.language_code; save() }
  if (r.kind === 'perm') {
    const ws = find(r.ws)
    if (ws) A.answer(ws, r.id, r.allow)
    await call('answerCallbackQuery', { callback_query_id: r.query, text: r.allow ? '✅' : '❌' })
    return call('editMessageReplyMarkup', { chat_id: cfg.chat, message_id: r.msg, reply_markup: { inline_keyboard: [] } })
  }
  if (r.kind === 'mute' || r.kind === 'unmute') { tg().muted = r.kind === 'mute'; save(); return tell(t(`telegram.${r.kind}d`)) }
  if (r.kind === 'status' || r.kind === 'start') return tell(status())
  const ws = find(r.ws)
  if (!ws) return tell(t('telegram.gone'))
  if (r.kind === 'stop') return A.interrupt(ws)
  if (ws === aiguilleur) { viaTelegram.add(ws.id); call('sendChatAction', { chat_id: cfg.chat, action: 'typing' }).catch(() => {}) }
  await send(ws, ws === aiguilleur ? `[Telegram] ${r.text}` : r.text).catch(e => { viaTelegram.delete(ws.id); tell('⚠️ ' + e.message, ws.id) })
}

async function poll() {
  for (;;) {
    try {
      for (const u of await call('getUpdates', { offset: tg().offset, timeout: 50, allowed_updates: ['message', 'callback_query'] })) {
        // Saved before handling: after a crash or restart, a message is never acted on twice.
        tg().offset = u.update_id + 1; save()
        await handle(u).catch(log)
      }
    } catch (e) { log(e); await new Promise(r => setTimeout(r, 5000)) }
  }
}

// opts.send(ws, text): the server's own send route (same checks as the chat). port: this server's.
export function start({ port, send: sendFn }) {
  // A workspace of its own outside every repo, so it can't edit any project's files (lib/agent.js inside()).
  aiguilleur = state.aiguilleur ??= { id: 'aiguilleur', name: 'aiguilleur', title: 'Aiguilleur', branch: '', base: '', permissionMode: 'auto', model: '', effort: '' }
  Object.assign(aiguilleur, { path: join(HOME, 'aiguilleur'), port, brief: brief(port) })
  mkdirSync(aiguilleur.path, { recursive: true })
  save()
  cfg = settings()
  if (!cfg) return
  send = sendFn
  // The point is to leave the Mac running: no idle sleep while Aiguillage is open (lid closed still sleeps).
  if (process.platform === 'darwin') spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}).unref()
  poll()
  console.log(cfg.chat == null ? '[telegram] on: send your bot a message to get your chat id' : '[telegram] on')
}
