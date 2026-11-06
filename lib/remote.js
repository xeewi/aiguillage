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
//   Photos, documents, voice notes… come with it as attachments; the aiguilleur passes them on to an agent's /send.
// Remote mode (the sidebar button, /remote and /local) decides whether Telegram is pushed anything: the whole
// conversation (reports, what the user types at the Mac, the aiguilleur's answers) and the permission requests and
// plans, with Allow / Deny buttons. Turning it on catches up: where every workspace stands, the reports missed
// meanwhile, the requests still waiting. Off, the linked chat can still write, and gets the answers to that.
// Where every workspace stands is a board: one message pinned at the top of the chat, edited in place (silently) as
// they work, in remote mode; /status posts it again. Messages go as rich messages: Telegram renders their Markdown.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { state, save, readLog, HOME, attachDir, fileName, newId } from './store.js'
import * as A from './agent.js'
import { i18n, fail } from './i18n.js'
import { metric } from './metrics.js'
import { parseReport, excerpt } from './report.js'
import { inspect } from './review.js'
import { config } from './config.js'

// One Telegram update -> what to do. sent: Telegram message id -> workspace id it reports on.
// code: while no chat is linked, the one-time code of the Settings link (t.me/<bot>?start=<code> sends « /start <code> »).
export function route(u, chat, sent, code) {
  const q = u.callback_query
  if (q) {
    if (chat == null || q.message?.chat?.id !== chat) return null
    const [k, ws, allow, ...id] = String(q.data ?? '').split(':')
    return k === 'p' ? { kind: 'perm', ws, allow: allow === '1', id: id.join(':'), query: q.id, msg: q.message.message_id } : null
  }
  const m = u.message, file = m && media(m)
  const text = (m?.text ?? m?.caption ?? '').trim()
  if (!text && !file) return null
  if (m.chat.id !== chat) {
    if (chat != null) return null
    return code && text === `/start ${code}` ? { kind: 'link', chat: m.chat.id, name: m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '' }
      : { kind: 'pair', chat: m.chat.id }
  }
  const cmd = file ? '' : text.split(/[\s@]/)[0]
  const reply = m.reply_to_message, ws = reply && sent.get(reply.message_id)
  if (cmd === '/stop') return { kind: 'stop', ws: ws ?? 'aiguilleur' }
  if (!reply && ['/status', '/remote', '/local', '/start', '/digest'].includes(cmd)) return { kind: cmd.slice(1) }
  // Everything else is for the aiguilleur, with the file it carries (album: the photos sent together, to gather).
  const files = file && { files: [file], ...m.media_group_id && { album: m.media_group_id } }
  // A reply to an agent's report or request says which workspace it is about.
  if (ws && ws !== 'aiguilleur') return { kind: 'send', about: ws, text, ...files }
  // A reply to a message we no longer map (sent before a restart): the aiguilleur gets the quote and sorts it out.
  const quote = reply?.text ?? reply?.caption
  return { kind: 'send', text: quote && !ws ? `> ${quote.slice(0, 600).replace(/\n/g, '\n> ')}\n\n${text}` : text, ...files }
}

// The file a message carries, if any: Telegram's id for it, a name (a photo, a voice note have none), its size.
// Photos come in several sizes, the largest last. Stickers, contacts, locations… are not files: ignored.
const KINDS = ['photo', 'document', 'video', 'audio', 'voice', 'animation', 'video_note']
const EXT = { 'image/jpeg': '.jpg', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a' }
export function media(m) {
  const kind = KINDS.find(k => m[k]), f = kind === 'photo' ? m.photo.at(-1) : m[kind]
  if (!f?.file_id) return null
  return { id: f.file_id, name: f.file_name || `${kind}-${m.message_id}${EXT[f.mime_type ?? { photo: 'image/jpeg', video_note: 'video/mp4' }[kind]] ?? ''}`, size: f.file_size }
}

export function brief(port) {
  const api = `http://127.0.0.1:${port}`
  return [
    "You are the aiguilleur (the switchman who sets the points) of Aiguillage, a local app on the user's Mac that runs several Claude Code agents in parallel, one per git worktree (a \"workspace\").",
    "The user talks to you from Aiguillage's window or, when away, from Telegram (their message then starts with [Telegram]): one conversation, shown on both sides. Be brief, in the user's language. Both sides render Markdown: keep it light (short paragraphs, lists, bold, `code`) so it reads well on a phone screen: no tables, no headings.",
    "You are the user's one interlocutor: the agents report to you and the user answers through you.",
    'Your role is to report and to relay, never to decide. The user makes every decision and gives every instruction:',
    "- You report: what each agent is doing, has done, is stuck on or asks. Facts, not advice, unless the user asks for your opinion.",
    "- You relay: when the user tells you to give an agent an instruction, send it what the user said, faithfully (their intent, their words where possible). Add only the context the agent needs to understand it; never add tasks, steps or choices of your own.",
    '- Nothing on your own initiative: no message to an agent, no new workspace, no interrupt, commit, merge or PR unless the user asked for that very action in their message. An agent asking a question or waiting for a choice is something you report to the user, not something you answer.',
    "- Unsure which workspace they mean or what exactly to send? Ask the user; don't guess.",
    `You don't write code. You read and act through Aiguillage's HTTP API at ${api} (curl; add -H "authorization: Bearer $AIGUILLAGE_TOKEN" to every call, or it is refused (401); POST bodies are JSON, with -H 'content-type: application/json'):`,
    '- GET /api/state: repos, and workspaces (id, repoId, name, title, branch, path, busy, failed, pending permission requests, archived). Ignore archived ones. Those with free: true are sessions tied to no project (no repo, branch or diff).',
    '- GET /api/workspaces/<id>/log: its conversation as a JSON array, often long: pipe it through python3 or jq and keep the last entries (cg_user = what the user said, assistant = the agent).',
    '- GET /api/workspaces/<id>/diff: its changes against its base branch.',
    '- POST /api/workspaces/<id>/send {"text": "...", "files": ["/path", ...]}: relay the user\'s instruction to that agent. When it finishes its turn, Aiguillage shows its report to the user in this conversation (and on Telegram) by itself: no need to wait for it or pass it on.',
    '- POST /api/workspaces/<id>/brief {"goal": "...", "scope": [], "done": [], "escalate": "..."} (goal required; scope = files or modules the agent may change, done = criteria to check, escalate = what to ask the user before): the brief for a new task. POST /api/workspaces also takes "brief" with the same fields.',
    "- To show the user an image, a video or a sound (a screenshot an agent took…), embed its absolute path as Markdown, ![caption](/path/to/shot.png): the window shows it, and Telegram gets it as a photo, video or file. Media in an agent's report reach the user by themselves.",
    "- Files the user sends you (photos, documents, voice notes from Telegram) are listed under \"Attached files\": when they are for an agent, pass their paths on in files, as given (the agent gets its own copy); other paths are ignored. Look at them only if you need to (to know which agent they're for, or when the user asks you). A voice note you can't listen to: transcribe it if a tool is at hand (whisper-cli, with ffmpeg), otherwise say so.",
    '- When the user asks for it: POST /api/workspaces/<id>/interrupt; POST /api/workspaces {"repoId": "...", "name": "short-slug"} (a new workspace, then relay their task to it); /commit {"message": "..."}, /merge, /pr, /archive; DELETE /api/workspaces/<id>.',
    "When the user gives an agent a new task, don't /send it: build a brief from the user's own words only (goal, scope, done criteria, what to escalate) — leave a field empty rather than invent it, ask the user if the goal is unclear — and POST it to /brief (or with the new workspace); the user approves it with a click. Follow-ups and answers to an agent's question still go through /send, faithfully.",
    'Creating a workspace, commit, merge, PR, archive and delete go to the user for a click: the call answers {pending}; tell the user you asked, the outcome comes as a report.',
    'Permission requests are not yours to answer: the user gets Allow / Deny buttons for them, in Aiguillage and on Telegram.',
    "Only the calls above are yours (and PATCH /api/workspaces/<id> {\"title\": \"...\"} to rename one): permission answers, an agent's model, effort or permission mode, revert, scripts, Settings and Telegram are the user's, and the API refuses them (403). Tell the user to do it.",
    'The repos are on disk (paths in /api/state): read them freely to answer questions about the projects, but never edit them.',
    'Your memory is the folder you run in, the only place you may write:',
    "- CLAUDE.md, loaded at the start of each of your sessions: a short index. The user's standing preferences about how you work, then one line per project (repo name, path, what it is) pointing to its notes.",
    "- projects/<repo name>.md: what you know about a project: purpose, stack, layout, how to run and test it, conventions, the work in progress, and the decisions the user took (with dates). Build a project's file the first time you need it (its README, CLAUDE.md, manifest, recent git log), read it before answering about that project, and update it when you learn something durable, from the repo, an agent's work or the user.",
    "- Its last section, ## Journal, is appended by Aiguillage after each agent turn (dated lines). Keep it last; fold what lasts into the sections above and trim the journal as it grows.",
    '- Facts only, short, dated when they can go stale; drop what is outdated. Never store secrets. Writing your notes is the one thing you do without being asked.',
    "Agents' reports (their last words when they finish a turn, marked ✅ (done), ⏸ (waiting on the user: blocked or a decision) or ❌ (failed) with the project and workspace) are shown to the user as they come. Those you haven't read yet head the user's next message, under [Reports from the agents since your last message]: take them in to know where things stand; don't repeat them unless asked.",
    "A message with [Reply to the report of <project> / <workspace> (id <id>)] is the user answering that agent: relay it to that workspace, faithfully, unless it is clearly a question for you.",
  ].join('\n')
}

let send = null, changed = () => {}
const sent = new Map()
const asked = new Set() // permission requests already posted
const last = new Map() // workspace id -> its last words this turn
let aiguilleur = null
const viaTelegram = new Set() // the aiguilleur's turns asked from Telegram: answered there even out of remote mode
// { token, bot, chat, chatName, code, remote, digest, queue, digestAt, offset, lang }, in state.json: never sent to the page (info() below).
const tg = () => (state.telegram ??= { offset: 0 })
const linked = () => !!tg().token && tg().chat != null
const remote = () => linked() && !!tg().remote
const batched = () => tg().digest !== 'off'
const missed = new Map() // workspace id -> [{ md, urgent }], its reports while remote mode was off (miss())
// ponytail: at most MISSED_MAX per workspace for the catch-up, the oldest dropped first.
const MISSED_MAX = 10
const t = (key, vars) => i18n.t(key, { lng: tg().lang, ...vars })
let ctl = new AbortController(), gen = 0, lastError = null, awake = null

const API = () => process.env.AIGUILLAGE_TELEGRAM_API || 'https://api.telegram.org'
// body: JSON, or a FormData for an upload (sendFile below).
async function call(method, body, token = tg().token) {
  const form = body instanceof FormData
  const r = await fetch(`${API()}/bot${token}/${method}`, { method: 'POST', headers: form ? {} : { 'content-type': 'application/json' },
    body: form ? body : JSON.stringify(body), signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(form ? 300_000 : 70_000)]) })
  const j = await r.json()
  if (!j.ok) throw new Error(`${method}: ${j.description}`)
  return j.result
}
const log = e => console.error('[telegram]', e.message)

// What Settings shows.
export function info() {
  const { token, bot, chat, chatName, code } = tg()
  return { on: !!token, bot, linked: chat != null, remote: remote(), digest: batched() ? 'batched' : 'off', chatName, code: chat == null ? code : undefined,
    link: token && chat == null && bot && code ? `https://t.me/${bot}?start=${code}` : undefined, error: token ? lastError : undefined }
}

// From Settings: a new token (checked with getMe) starts over, waiting for the user's link; '' disconnects.
export async function connect(token) {
  token = String(token ?? '').trim()
  let bot
  if (token) bot = (await call('getMe', {}, token).catch(() => { throw fail('errors.telegramToken') })).username
  state.telegram = token ? { token, bot, chat: null, chatName: null, code: randomBytes(6).toString('hex'), offset: 0, lang: tg().lang, digest: tg().digest } : { offset: 0, lang: tg().lang, digest: tg().digest }
  lastError = null
  save(); restart(); changed()
}

// A text too long for one message -> parts of at most max characters, cut between lines (a line longer than half of
// max is cut too). A code block cut in two is closed at the end of the part and opened again in the next.
export function split(text, max) {
  if (text.length <= max) return [text]
  const parts = []
  let cur = '', open = null // the code block cur ends inside: its opening line and fence
  for (const line of text.split('\n').flatMap(l => l.match(new RegExp(`[^]{1,${max >> 1}}`, 'g')) ?? [''])) {
    // 20: room to close a code block the line may open
    if (cur && cur.length + 1 + line.length + 20 > max) { parts.push(open ? cur + '\n' + open.fence : cur); cur = open?.line ?? '' }
    cur = cur ? cur + '\n' + line : line
    const f = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!f) continue
    if (!open) open = { line: line.slice(0, 100), fence: f[1] }
    else if (f[1][0] === open.fence[0] && f[1].length >= open.fence.length && !f[2].trim()) open = null
  }
  return [...parts, cur]
}

// Each part its own message, the buttons under the last one.
async function inParts(parts, extra, send) {
  const ms = []
  for (const [i, p] of parts.entries()) ms.push(await send(p, i < parts.length - 1 ? { ...extra, reply_markup: undefined } : extra))
  return ms.flat()
}

// Rich messages: Telegram renders their Markdown (GitHub-flavoured: what the agents write). A long text goes in several
// (32768 characters at most each, 4096 as plain text). A part Telegram refuses to parse goes again as plain text,
// Markdown shown as is.
// ponytail: RICH under half the limit, in case Telegram counts UTF-8 bytes.
const RICH = 16_000, PLAIN = 4096
async function tell(text, wsId, extra = {}) {
  if (!linked()) return
  const chat_id = tg().chat
  const ms = await inParts(split(text || '…', RICH), extra, (part, x) => call('sendRichMessage', { chat_id, rich_message: { markdown: part }, ...x })
    .catch(e => {
      if (!e.message.startsWith('sendRichMessage:')) throw e
      return inParts(split(part, PLAIN), x, (p, y) => call('sendMessage', { chat_id, text: p, ...y }))
    }))
  metric('push')
  if (wsId) for (const m of ms) { sent.set(m.message_id, wsId); if (sent.size > 1000) sent.delete(sent.keys().next().value) }
}

// The media a message shows, the chat's way (![caption](path), or a link to a video or a sound): local files only.
const SHOWN = /(!?)\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))\)/g
const MEDIA = /\.(png|jpe?g|gif|webp|avif|svg|mp4|m4v|mov|webm|ogv|mp3|wav|ogg|m4a|aac|flac)$/i
const local = p => !/^[a-z][\w+.-]*:|^\/attachments\/|^#/i.test(p) && MEDIA.test(p)
const unescape = p => { try { return decodeURIComponent(p) } catch { return p } }
const each = (text, fn) => text.replace(SHOWN, (all, bang, alt, a, b) => local(a ?? b) ? fn(alt, unescape(a ?? b), bang) : all)
// An agent's paths are from its worktree: made absolute in its report, so the aiguilleur's window, its model and
// Telegram find the files.
export const absolute = (text, base) => each(text, (alt, p, bang) => /^[/~]/.test(p) ? `${bang}[${alt}](<${p}>)` : `${bang}[${alt}](<${join(base, p)}>)`)
// The message as Telegram shows it, a 📎 and its caption in place of each media, and those files, sent after it.
export function forTelegram(text, base) {
  const files = []
  const out = each(text, (alt, p) => {
    const path = resolve(base, p.replace(/^~(?=$|\/)/, homedir()))
    files.push({ path, caption: alt })
    return `📎 ${alt || md(basename(path))}`
  })
  return { text: out, files }
}

// A message of the conversation, then the media it shows, each as a photo, a video, a sound or a file.
// ponytail: one message per file, no albums; 10 at most.
async function share(text, wsId) {
  const s = forTelegram(text, aiguilleur.path)
  await tell(s.text, wsId)
  for (const f of s.files.slice(0, 10)) await sendFile(f, wsId).catch(e => tell(`⚠️ ${md(basename(f.path))}: ${e.message}`).catch(log))
}

// Bots upload 50 MB at most. A photo Telegram refuses (over 10 MB, too long or thin) goes as a plain file.
const MAX_UPLOAD = 50 * 2 ** 20
const SEND = { Photo: /\.(png|jpe?g|webp)$/i, Animation: /\.gif$/i, Video: /\.(mp4|m4v|mov)$/i, Audio: /\.(mp3|m4a)$/i }
async function sendFile({ path, caption }, wsId) {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st?.isFile()) throw new Error(t('telegram.mediaMissing'))
  if (st.size > MAX_UPLOAD) throw new Error(t('telegram.mediaTooBig'))
  const up = kind => {
    const form = new FormData()
    form.set('chat_id', String(tg().chat))
    if (caption) form.set('caption', caption.slice(0, 1024))
    form.set(kind.toLowerCase(), new Blob([readFileSync(path)]), basename(path))
    return call(`send${kind}`, form)
  }
  const kind = Object.keys(SEND).find(k => SEND[k].test(path)) ?? 'Document'
  const m = await up(kind).catch(e => kind === 'Document' ? Promise.reject(e) : up('Document'))
  if (wsId) { sent.set(m.message_id, wsId); if (sent.size > 1000) sent.delete(sent.keys().next().value) }
}

// Our own text (names, tool names) inside Markdown: shown as written.
export const md = s => String(s).replace(/[\\`*_[\]<>#|~=$]/g, '\\$&')
const fence = s => '```\n' + String(s).replace(/```/g, '`​``') + '\n```'

const find = id => id === 'aiguilleur' ? aiguilleur : state.workspaces.find(w => w.id === id && !w.archived)
// The project, then the workspace: its task's title and its name.
const repoName = ws => ws.free ? 'Session' : state.repos.find(r => r.id === ws.repoId)?.name ?? '?'
export const label = ws => ws === aiguilleur ? '' : `${repoName(ws)} / ${ws.title || ws.name}`
// A red check is as bad as a failed turn (the page agrees); a turn the user stopped is neither good nor bad.
export const icon = ev => !ev.ok || ev.check?.ok === false ? '❌' : ev.interrupted ? '⏹' : ev.status === 'blocked' || ev.status === 'decision' ? '⏸' : '✅'
const touched = (ev, lng) => ev.testsTouched?.length && i18n.t('report.testsTouched', { lng, files: ev.testsTouched.join(', ') })
// The check's verdict, then its output when it failed.
const checked = (ev, lng, wrap) => ev.check && [wrap(i18n.t(ev.check.ok ? 'report.checkPassed' : 'report.checkFailed', { lng, s: Math.round(ev.check.ms / 1000), code: ev.check.code ?? '⏱' })), !ev.check.ok && ev.check.out && fence(ev.check.out)].filter(Boolean).join('\n\n')
// A text the server wrote, as { key, vars } (a var may be one too), in the reader's language; a plain string as is;
// a list, its lines.
export const tr = (d, lng) => Array.isArray(d) ? d.map(x => tr(x, lng)).join('\n')
  : d?.key ? i18n.t(d.key, { lng, ...Object.fromEntries(Object.entries(d.vars ?? {}).map(([k, v]) => [k, tr(v, lng)])) }) : d
// What Aiguillage says in a report (key + vars), what the agent said (text), and that it waits in the queue.
const said = (ev, lng, wrap) => [ev.key && wrap(tr(ev, lng)), ev.text, ev.queued && wrap(i18n.t('chat.queued', { lng, context: ev.queued }))]
// The aiguilleur's model reads English; Telegram, the chat's language.
export const reportText = ev => [`${icon(ev)} ${tr(ev.label, 'en')}`, ...said(ev, 'en', s => s), touched(ev, 'en'), checked(ev, 'en', s => s)].filter(Boolean).join('\n\n')
// What needs the user now; the other reports wait for the digest. action: the outcome of something the user just confirmed.
export const urgent = ev => !ev.ok || ev.status === 'blocked' || ev.status === 'decision' || ev.check?.ok === false || !!ev.testsTouched?.length || !!ev.overlap || !!ev.stall || !!ev.action
// ponytail: fixed slots (local time); a setting if anyone asks.
export const DIGEST_HOURS = [9, 13, 18]
// A slot passed in ]lastSent, now]: the latest slot at or before now is later than lastSent.
export function dueSlot(lastSent, now, hours = DIGEST_HOURS) {
  const d = new Date(now), slots = [-1, 0].flatMap(back => hours.map(h => new Date(d.getFullYear(), d.getMonth(), d.getDate() + back, h).getTime()))
  const at = Math.max(...slots.filter(x => x <= now))
  return at > lastSent
}
// One line per waiting report: its title (icon and label) and the first line of its text, escaped here only.
// line: that text as written (digestItem); items queued before it existed fall back on their Markdown.
export const digestText = (queue, t) => [`**${t('telegram.digestTitle', { count: queue.length })}**`,
  ...queue.map(({ md: m, line }) => { const [head, body = ''] = m.split('\n\n'); return `${head} ${md((line ?? body).replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim().split('\n')[0].slice(0, 120))}`.trim() })].join('\n\n')
// The digest window starts with the first waiting report.
export function enqueue(g, item, now = Date.now()) {
  if (!g.queue?.length) g.digestAt = now
  ;(g.queue ??= []).push(item)
}
export const reportMd = (ev, lng = tg().lang) => [`**${icon(ev)} ${md(tr(ev.label, lng))}**`, ...said(ev, lng, md), touched(ev, lng) && md(touched(ev, lng)), checked(ev, lng, md)].filter(Boolean).join('\n\n')
// A report waiting for the digest: its Markdown, and its text's first part unescaped.
export const digestItem = (ev, lng = tg().lang) => ({ ws: ev.ws, md: reportMd(ev, lng), line: [...said(ev, lng, s => s), touched(ev, lng), checked(ev, lng, s => s)].find(Boolean) ?? '' })

// A report in the aiguilleur's conversation. title replaces the workspace's label (an overlap: « A ↔ B »);
// extra fields ride along on the event. What Aiguillage itself says goes as key + vars (lib/i18n.js notice()),
// translated when shown (tr()); text is for the agent's own words.
export function report(ws, { ok, status = null, text = '', title, ...extra }) {
  A.record(aiguilleur, { type: 'cg_report', ws: ws.id, label: title ?? label(ws), ok, status, text, ts: Date.now(), ...extra })
}

// Every agent event (lib/agent.js record): keep what was asked and the agent's words. When a workspace's turn ends,
// note what's worth remembering and report it in the aiguilleur's conversation; that conversation goes to Telegram.
export function onEvent(m) {
  if (m.t !== 'ev' || !aiguilleur) return
  const ws = find(m.ws), ev = m.ev
  if (!ws) return
  if (ev.type === 'cg_user') asks.set(ws.id, { text: ev.text, cp: ev.cp })
  if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
    const text = (ev.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    if (text) last.set(ws.id, text)
    const tool = (ev.message?.content ?? []).findLast(c => c.type === 'tool_use')
    if (tool && ws !== aiguilleur) { doing.set(ws.id, { since: doing.get(ws.id)?.since ?? Date.now(), what: activity(tool) }); refresh() }
  }
  if (ws === aiguilleur) return mirror(ev)
  // The watchdog (lib/agent.js): reported, the agent keeps working.
  if (ev.type === 'cg_stall') {
    metric('stall', { ws: ws.id, reason: ev.reason })
    return report(ws, { ok: true, status: 'blocked', stall: ev.reason, key: `stall.${ev.reason}`, vars: { min: Math.round(A.STALL_SILENT / 60_000) } })
  }
  if (ev.type !== 'result' && ev.type !== 'cg_error') return
  doing.delete(ws.id)
  const stopped = stoppedTurn(ev, ws)
  const ok = ev.type === 'result' && (!ev.is_error || stopped)
  const words = ev.type === 'cg_error' ? ev.text : ev.is_error && !stopped ? ev.error ?? '' : last.get(ws.id) ?? ''
  last.delete(ws.id)
  const ask = asks.get(ws.id)
  if (ok && !stopped) remember(ws, ask?.text ?? '', words)
  const { status } = parseReport(words)
  const end = A.endTree(ws.id) // taken as the turn ended, before the chain's wait
  // One chain per workspace: reports are recorded in turn order even though inspect() takes time.
  const done = (turns.get(ws.id) ?? Promise.resolve()).then(async () => {
    // Config is read inside the guard too: any failure still records the report, without the facts.
    const found = await (async () => inspect(ws, ask?.cp, config(ws.path, state.repos.find(r => r.id === ws.repoId)?.path), end))().catch(e => (console.error('[review]', e.message), {}))
    const { check } = found
    // The CLI exiting is Aiguillage's words (key + vars), not the agent's.
    const body = ev.type === 'cg_error' && ev.key ? { key: ev.key, vars: ev.vars } : { ...stopped && { interrupted: true, key: 'report.interrupted' }, text: absolute(words, ws.path) }
    report(ws, { ok, status, ...body, ...found.testsTouched?.length && { testsTouched: found.testsTouched }, ...check && { check: { ok: check.ok, code: check.code, ms: check.ms, out: check.out } } })
    metric('report', { ws: ws.id, block: status !== null })
    Promise.resolve().then(() => afterTurn(ws)).catch(log) // not awaited: a slow scan must not hold this workspace's next report
  }).catch(log)
  turns.set(ws.id, done)
}
// A stop the user asked for isn't a failure (lib/agent.js a.failed, set just before this event): ⏹ and the agent's last words.
const stoppedTurn = (ev, ws) => ev.type === 'result' && !!ev.is_error && !A.runtime(ws.id).failed
let afterTurn = () => {}
const turns = new Map() // workspace id -> its last report in the making

// The aiguilleur's conversation on Telegram: all of it in remote mode; otherwise only the answers to what was asked
// from there, and the reports wait for the catch-up (setRemote).
function mirror(ev) {
  if (!linked()) return
  if (ev.type === 'cg_report') {
    if (!remote()) return miss(ev)
    if (urgent(ev) || !batched()) return share(reportMd(ev), ev.ws).catch(log)
    const q = tg()
    enqueue(q, digestItem(ev)); save() // survives a restart
    return
  }
  if (ev.type === 'cg_user') return ev.via !== 'telegram' && remote() && tell(`${t('telegram.fromMac')}\n\n${ev.text}`).catch(log)
  if (ev.type !== 'result' && ev.type !== 'cg_error') return
  const stopped = stoppedTurn(ev, aiguilleur)
  const words = ev.type === 'cg_error' ? ev.text : ev.is_error && !stopped ? ev.error ?? '' : last.get(aiguilleur.id) ?? ''
  last.delete(aiguilleur.id)
  if (!viaTelegram.delete(aiguilleur.id) && !remote()) return
  share([stopped ? `⏹ ${t('report.interrupted')}` : ev.is_error || ev.type === 'cg_error' ? '❌' : '', words].filter(Boolean).join('\n\n'), aiguilleur.id).catch(log)
}

// A report while remote mode is off, for the catch-up: every urgent one, and the latest of the others.
function miss(ev) {
  const u = urgent(ev), kept = (missed.get(ev.ws) ?? []).filter(x => u || x.urgent)
  missed.set(ev.ws, [...kept, { md: reportMd(ev), urgent: u }].slice(-MISSED_MAX))
}

// The waiting reports in one message (push), then the queue is empty.
let digesting = false
export async function sendDigest() {
  if (digesting) return
  const g = tg(), sending = (g.queue ?? []).slice()
  if (!sending.length) return tell(t('telegram.digestEmpty'))
  digesting = true
  try {
    await tell(digestText(sending, t))
    if (state.telegram !== g) return // disconnected (or another token) meanwhile: that queue is gone
    // Only what was sent leaves the queue (reports may have joined meanwhile); a failed send keeps everything.
    g.queue = g.queue.slice(sending.length); g.digestAt = Date.now(); save()
  } finally { digesting = false }
}
setInterval(() => { if (remote() && tg().queue?.length && dueSlot(tg().digestAt ?? 0, Date.now())) sendDigest().catch(log) }, 60_000).unref()

// What the aiguilleur's model reads for a message of the user's: the reports logged since the user's last message
// (it hasn't seen them), then the message, with where it comes from. about: the workspace whose report it answers.
// ponytail: reads the whole log per message; cut each report and keep the latest, the full text is in the API.
const MAX_REPORTS = 30, MAX_REPORT = 2000
export function prompt(text, { via, about } = {}, log = readLog('aiguilleur')) {
  const reports = log.slice(log.findLastIndex(e => e.type === 'cg_user') + 1).filter(e => e.type === 'cg_report')
  const kept = reports.slice(-MAX_REPORTS).map(e => reportText({ ...e, text: excerpt(e.text, MAX_REPORT) }) + `\n(workspace id ${e.ws})`)
  const head = reports.length && ['[Reports from the agents since your last message]',
    reports.length > kept.length && `(${reports.length - kept.length} older ones left out: GET /api/workspaces/aiguilleur/log)`, ...kept].filter(Boolean).join('\n\n')
  const ws = about && find(about)
  const msg = [via === 'telegram' && '[Telegram]', ws && `[Reply to the report of ${label(ws)} (id ${ws.id})]`, text].filter(Boolean).join(' ')
  return [head, msg].filter(Boolean).join('\n\n---\n\n')
}

// Whether the aiguilleur starts a new session before this message. It relays, and what lasts is in its notes, so an
// old conversation is mostly a cost: each request re-reads all of it. Fresh after an hour without a message (the
// prompt cache has expired anyway: the whole context would be written again) or past FULL tokens of context.
// ponytail: fixed thresholds; a setting if the user ever wants a longer memory.
export const IDLE = 3600_000, FULL = 100_000
export function stale(log, context, now = Date.now()) {
  const last = log.findLast(e => e.type === 'cg_user' || e.type === 'cg_clear')
  return last?.type === 'cg_user' && (now - last.ts > IDLE || (context?.used ?? 0) > FULL)
}

// Remote mode on/off, from the sidebar (server.js) or Telegram. On: catch up with everything, then push.
export function setDigest(mode) { tg().digest = mode === 'off' ? 'off' : 'batched'; save(); changed() }
export async function setRemote(on) {
  if (!linked()) throw fail('errors.telegramNotLinked')
  tg().remote = !!on; save(); keepAwake(); changed()
  if (!on) { await edit(); return tell(t('telegram.remoteOff')) }
  await tell(t('telegram.remoteOn'))
  await post()
  // The digest whose slot passed while off (its reports came first), then what was missed.
  if (tg().queue?.length && dueSlot(tg().digestAt ?? 0, Date.now())) await sendDigest().catch(log)
  for (const [id, list] of missed) if (find(id)) for (const r of list) await share(r.md, id)
  missed.clear()
  asked.clear(); sync() // requests still waiting come again, with their buttons
}

// ---------- the aiguilleur's memory: each agent turn adds its durable facts to the project's journal ----------
const asks = new Map() // workspace id -> { text: what the user last asked it, cp: the checkpoint before }
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

// Whether the aiguilleur's turn now was asked from Telegram (server.js guard marks what it asks to do in it).
export const fromTelegram = () => viaTelegram.has(aiguilleur.id)

// After each state change: post permission requests not posted yet, bring the board up to date. Out of remote mode,
// only what the aiguilleur asked to do in a turn from Telegram (p.telegram): the user is there, waiting for its buttons.
export function sync() {
  if (!linked()) return
  const on = remote()
  if (on) refresh()
  for (const ws of [aiguilleur, ...state.workspaces]) for (const p of A.runtime(ws.id).pending) {
    if (asked.has(p.id) || !on && !p.telegram) continue
    asked.add(p.id)
    const what = p.tool === 'ExitPlanMode' ? t('perm.proposesPlan') + '\n\n' + (p.input.plan ?? '')
      : p.confirm ? md(t('perm.confirmAction')) + '\n\n' + fence(p.key ? tr(p, tg().lang) : p.input.command) // what the aiguilleur asks to do (server.js guard)
      : md(t('perm.wantsTool', { tool: p.tool })) + '\n\n' + fence(p.input.command ?? p.input.file_path ?? JSON.stringify(p.input, null, 1))
    const buttons = [[{ text: t('perm.allow'), style: 'success', callback_data: `p:${ws.id}:1:${p.id}` },
      { text: t('perm.deny'), style: 'danger', callback_data: `p:${ws.id}:0:${p.id}` }]]
    tell(`**🔐 ${md(label(ws) || 'Aiguilleur')}**\n\n${what}`, ws.id, { reply_markup: { inline_keyboard: buttons } }).catch(log)
  }
}

// ---------- the board: where every workspace stands, one pinned message edited in place ----------
const doing = new Map() // workspace id -> { since: when its turn started working, what: its last tool call }
// A tool call -> a few words: the Bash's own description, else its command; the file it touches; what it looks for.
export function activity({ name, input: i = {} }) {
  const arg = i.description ?? i.command ?? (i.file_path ?? i.notebook_path)?.split('/').pop() ?? i.pattern ?? i.url ?? i.query ?? ''
  const short = String(arg).split('\n')[0]
  return short ? `${name}: ${short.length > 50 ? short.slice(0, 49) + '…' : short}` : name
}

// rows: [{ repo, title, pending: tool or undefined, working, queued, failed, what, since }], usage: lib/agent.js usageNow()
// -> the board's text. Its first line, the counts, is what the pinned bar shows at the top of the chat; then the
// plan's session and week; then each repo once, its workspaces by their short title, the resting ones on one line.
// queued: messages waiting for a free slot (server.js sendTo).
const ORDER = ['pending', 'working', 'queued', 'failed', 'idle'], ICON = { pending: '🔐', working: '⏳', queued: '🕒', failed: '❌', idle: '💤' }
const short = (s, n = 30) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
export function boardText(rows, { t, now = Date.now(), paused = false, usage = null, lang }) {
  const kind = r => r.pending ? 'pending' : r.working ? 'working' : r.queued ? 'queued' : r.failed ? 'failed' : 'idle'
  const sorted = rows.map(r => ({ ...r, kind: kind(r) })).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
  const counts = ORDER.map(k => [k, sorted.filter(r => r.kind === k).length]).filter(([, n]) => n)
  const hm = m => m < 60 ? t('usage.min', { m }) : t('usage.hm', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') })
  const took = since => { const m = Math.floor((now - since) / 60_000); return m < 1 ? '' : hm(m) }
  const reset = at => { const m = Math.max(0, Math.round((at - now) / 60_000))
    return m < 24 * 60 ? t('usage.resetsIn', { time: hm(m) }) : t('usage.resetsAt', { when: new Intl.DateTimeFormat(lang, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at) }) }
  const lanes = ['session', 'weekly_all'].map(k => usage?.limits.find(l => l.kind === k)).filter(Boolean)
    .map(l => [`${l.pct >= 90 ? '🔴' : '📊'} ${t(l.kind === 'session' ? 'usage.session' : 'usage.week')} ${l.pct} %`, l.resetsAt && reset(l.resetsAt)].filter(Boolean).join(' · '))
  const name = r => short(r.title) + (r.red ? ' 🧪❌' : '') + (r.overlap ? ' ⚠️' : '')
  const line = r => [`${ICON[r.kind]} ${name(r)}`,
    r.kind === 'pending' ? t('telegram.board.asks', { tool: r.pending }) : r.kind === 'working' ? [r.what, r.since && took(r.since)].filter(Boolean).join(' · ') : ''].filter(Boolean).join(' — ')
  const repos = [...new Set(sorted.map(r => r.repo))].map(repo => {
    const mine = sorted.filter(r => r.repo === repo), idle = mine.filter(r => r.kind === 'idle')
    return [`\n▸ ${repo}`, ...mine.filter(r => r.kind !== 'idle').map(line), idle.length && `💤 ${idle.map(name).join(' · ')}`].filter(Boolean).join('\n')
  })
  return [counts.map(([k, n]) => `${ICON[k]} ${t(`telegram.board.${k}`, { count: n })}`).join(' · ') || t('telegram.none'),
    ...lanes, ...repos, rows.some(r => r.overlap) && `\n${t('telegram.board.overlap')}`, paused && `\n${t('telegram.board.paused')}`].filter(Boolean).join('\n')
}

// 🧪❌ on the board: the stored check is red, on the files as they are (checkStale: lib/review.js inspect, a revert),
// and it ran the repo's check command as it is now (command() reads the config: only asked for a red one).
export const redCheck = (w, command) => { const c = w.check?.ok === false && !w.checkStale && command(); return !!c && c === w.check.command }

function board() {
  const now = Date.now()
  const rows = state.workspaces.filter(w => !w.archived).map(w => {
    const r = A.runtime(w.id), working = A.working(r)
    if (!working) doing.delete(w.id)
    else if (!doing.has(w.id)) doing.set(w.id, { since: now, what: '' })
    return { repo: repoName(w), title: w.title || w.name, red: redCheck(w, () => !w.free && config(w.path, state.repos.find(r => r.id === w.repoId)?.path).check), overlap: Object.keys(state.overlaps ?? {}).some(k => k.split('|').includes(w.id)), pending: r.pending[0]?.tool, working, queued: !!w.queued?.length, failed: r.failed, ...doing.get(w.id) }
  })
  return boardText(rows, { t, now, paused: !remote(), usage: A.usageNow(), lang: tg().lang }).slice(0, 4000)
}

let shown = '', timer = null
// A new board at the bottom of the chat, pinned (silently), in place of the previous one.
async function post() {
  const old = tg().board
  shown = board()
  const m = await call('sendMessage', { chat_id: tg().chat, text: shown, disable_notification: true })
  tg().board = m.message_id; save()
  await call('pinChatMessage', { chat_id: tg().chat, message_id: m.message_id, disable_notification: true }).catch(log)
  if (old) call('deleteMessage', { chat_id: tg().chat, message_id: old }).catch(() => call('unpinChatMessage', { chat_id: tg().chat, message_id: old }).catch(() => {}))
}
// The board as it stands now, if it changed. Gone (deleted by the user)? A new one.
async function edit() {
  if (!linked() || tg().board == null) return
  const text = board()
  if (text === shown) return
  shown = text
  await call('editMessageText', { chat_id: tg().chat, message_id: tg().board, text })
    .catch(e => /not found|can't be edited/i.test(e.message) ? post() : /not modified/i.test(e.message) || log(e))
}
// ponytail: at most one edit every 2 s (Telegram allows about one message a second per chat); a minute tick for the durations.
function refresh() {
  if (timer || !remote()) return
  timer = setTimeout(() => { timer = null; edit().catch(log) }, 2000)
}
setInterval(refresh, 60_000).unref()

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
    const ws = find(r.ws), done = !!ws && A.answer(ws, r.id, r.allow)
    await call('answerCallbackQuery', { callback_query_id: r.query, text: !done ? t('telegram.notPending') : r.allow ? '✅' : '❌' })
    return call('editMessageReplyMarkup', { chat_id: tg().chat, message_id: r.msg, reply_markup: { inline_keyboard: [] } })
  }
  if (r.kind === 'status' || r.kind === 'start') return post()
  if (r.kind === 'digest') return sendDigest()
  const ws = find(r.kind === 'stop' ? r.ws : r.about ?? 'aiguilleur')
  if (!ws) return tell(t('telegram.gone'))
  if (r.kind === 'stop') return A.interrupt(ws)
  if (!r.album) return toAiguilleur(r)
  // An album comes as one message per photo, the caption on one of them: gathered into one message, sent once they're in.
  // ponytail: a fixed wait; an album slower than that to arrive goes in two messages.
  const a = albums.get(r.album)
  if (a) { a.files.push(...r.files); a.text ||= r.text; return }
  albums.set(r.album, r)
  setTimeout(() => { albums.delete(r.album); toAiguilleur(r) }, ALBUM_WAIT)
}
const albums = new Map() // media_group_id -> the message gathering it
const ALBUM_WAIT = 1500

async function toAiguilleur(r) {
  viaTelegram.add(aiguilleur.id); call('sendChatAction', { chat_id: tg().chat, action: 'typing' }).catch(() => {})
  try {
    await send(aiguilleur, r.text, await Promise.all((r.files ?? []).map(download)), { via: 'telegram', about: r.about })
  } catch (e) { viaTelegram.delete(aiguilleur.id); await tell('⚠️ ' + e.message).catch(log) }
}

// A file the user sent, saved with the aiguilleur's attachments like the chat's uploads: a folder each, its own name.
// Telegram lets a bot download 20 MB at most (more takes a self-hosted Bot API server).
const MAX_DOWNLOAD = 20 * 2 ** 20
async function download(f) {
  if (f.size > MAX_DOWNLOAD) throw new Error(t('telegram.tooBig', { name: f.name }))
  const { file_path } = await call('getFile', { file_id: f.id })
  const r = await fetch(`${API()}/file/bot${tg().token}/${file_path}`, { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(120_000)]) })
  if (!r.ok) throw new Error(`download ${f.name}: ${r.status}`)
  const path = join(attachDir(aiguilleur.id), newId(), fileName(f.name))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(await r.arrayBuffer()))
  return path
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
const commands = () => call('setMyCommands', { commands: ['remote', 'local', 'status', 'digest', 'stop'].map(c => ({ command: c, description: t(`telegram.cmd.${c}`) })) }).catch(log)
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
export function start({ port, send: sendFn, changed: changedFn, afterTurn: afterFn }) {
  // A workspace of its own outside every repo, so it can't edit any project's files (lib/agent.js inside()).
  aiguilleur = state.aiguilleur ??= { id: 'aiguilleur', name: 'aiguilleur', title: 'Aiguilleur', branch: '', base: '', permissionMode: 'auto', model: '', effort: '' }
  Object.assign(aiguilleur, { path: join(HOME, 'aiguilleur'), port, brief: brief(port) })
  mkdirSync(aiguilleur.path, { recursive: true })
  save()
  send = sendFn; changed = changedFn ?? changed; afterTurn = afterFn ?? afterTurn
  restart()
}
