import { marked } from '/vendor/marked.js'
import DOMPurify from '/vendor/purify.js'
import { Terminal } from '/vendor/xterm.js'
import { FitAddon } from '/vendor/addon-fit.js'
import { t, LANGS, lang, setLang, translateDom } from '/i18n.js'

const $ = s => document.querySelector(s)
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const md = s => embedMedia(DOMPurify.sanitize(marked.parse(s || ''), { RETURN_DOM_FRAGMENT: true }))
// Local files the agent embeds or links (![shot](out/home.png), [demo](/tmp/demo.mp4)) show in the chat, served by /media.
const VIDEO = /\.(mp4|m4v|mov|webm|ogv)$/i, AUDIO = /\.(mp3|wav|ogg|m4a|aac|flac)$/i, IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i
const mediaUrl = p => '/media?path=' + encodeURIComponent(p)
function localMedia(ref) {
  if (!ref || /^[a-z][\w+.-]*:|^\/attachments\/|^#/i.test(ref)) return null // web, data:, the app's own URLs
  let p = ref.split(/[?#]/)[0]; try { p = decodeURIComponent(p) } catch {}
  if (!VIDEO.test(p) && !AUDIO.test(p) && !IMAGE.test(p)) return null
  const w = wsById(active)
  return /^[/~]/.test(p) ? p : w && w.path + '/' + p.replace(/^\.\//, '')
}
function embedMedia(frag) {
  for (const n of frag.querySelectorAll('img[src], a[href]')) {
    const p = localMedia(n.getAttribute(n.tagName === 'IMG' ? 'src' : 'href')); if (!p) continue
    const m = h(VIDEO.test(p) ? 'video' : AUDIO.test(p) ? 'audio' : 'img', 'media')
    m.src = mediaUrl(p)
    if (m.tagName === 'IMG') { m.alt = n.alt || n.textContent; m.title = p } else { m.controls = true; m.preload = 'metadata' }
    n.replaceWith(m)
  }
  return frag
}
// One small icon set, same 16px grid and stroke.
const ICONS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H7"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  pause: '<path d="M6 3.5v9M10 3.5v9"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  down: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
  side: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/>',
  panelBelow: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M2 9h12"/>',
  panelRight: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M9.5 2.5v11"/>',
  clip: '<path d="M13 7.5 8.2 12.3a3.3 3.3 0 0 1-4.7-4.7l5-5a2.2 2.2 0 0 1 3.1 3.1l-5 5a1.1 1.1 0 0 1-1.6-1.6L9.5 4.6"/>',
  file: '<path d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25z"/><path d="M9 1.75v3.5h3.5"/>',
  chat: '<path d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.5l-3 2.5V11H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z"/>',
  aiguilleur: '<circle cx="8" cy="8" r="2.25"/><path d="M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5"/>',
  phone: '<rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5"/><path d="M7.25 11.75h1.5"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
}
const svg = n => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`
const ibtn = (n, label, cls = '') => { const b = h('button', 'ghost icon ' + cls); b.innerHTML = svg(n); b.title = label; b.setAttribute('aria-label', label); return b }

let S = { repos: [], workspaces: [] }
// The last workspace and tab come back when the app restarts (an update, a quit).
let active = new URLSearchParams(location.hash.slice(1)).get('ws') || localStorage.getItem('aig.ws')
let tab = ['diff', 'term', 'run'].includes(localStorage.getItem('aig.tab')) ? localStorage.getItem('aig.tab') : 'diff'
// Sessions with a turn you haven't seen, or marked unread by hand (right-click); kept across restarts.
const unread = new Set(JSON.parse(localStorage.getItem('aig.unread') || '[]'))
const setUnread = (id, on) => { unread[on ? 'add' : 'delete'](id); localStorage.setItem('aig.unread', JSON.stringify([...unread])) }
// The aiguilleur (lib/remote.js) opens like a workspace, minus the worktree: no branch, Diff, Terminal or Run.
const wsById = id => id === 'aiguilleur' ? S.aiguilleur : S.workspaces.find(w => w.id === id)
// Chat only, no Diff / Terminal / Run panel: the aiguilleur, and the sessions tied to no project (w.free, server.js createSession).
const solo = w => !!(w?.aiguilleur || w?.free)
// Shown name: the task name (Claude's summary of the first message, or the user's rename), else the city.
const label = w => w.aiguilleur ? t('side.aiguilleur') : w.title || w.name

// ---------- server ----------
async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  // Server errors and notices come with a translation key; the English text is the fallback.
  if (!r.ok) throw Object.assign(new Error(j.key ? t(j.key, j.vars) : j.error || r.statusText), { key: j.key })
  if (j.key) j.message = t(j.key, j.vars)
  return j
}
const toast = (msg, bad) => {
  const t = $('#toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, bad ? 8000 : 3500)
}
const guard = fn => async (...a) => { try { await fn(...a) } catch (e) { toast(e.message, true) } }

let sock
function connect() {
  sock = new WebSocket(`ws://${location.host}`)
  sock.onmessage = e => onMsg(JSON.parse(e.data))
  sock.onclose = () => setTimeout(connect, 1000)
  sock.onopen = () => { for (const k of terms.keys()) send({ t: 'term:open', key: k }) }
}
const send = m => sock?.readyState === 1 && sock.send(JSON.stringify(m))

function onMsg(m) {
  if (m.t === 'state') {
    S = m; renderSide(); renderHead(); renderPerms(); renderTasks(); renderSettings(); renderUpdate(); renderUsage()
    if (tab === 'term' && wsById(active) && !solo(wsById(active)) && termShown !== termKey()) showTab('term') // the terminal Claude Code started or quit
  }
  else if (m.t === 'ev') {
    if (m.ws === active) { dropDraft(); renderEv(m.ev); scroll() }
    if (m.ev.type === 'result') {
      cmds.delete(m.ws)
      if (m.ws === active && !solo(wsById(m.ws))) loadDiff()
      if (m.ws === active && tab === 'run') loadScripts()
      if (m.ws !== active || document.hidden) { setUnread(m.ws, true); renderSide(); notify(m.ws, m.ev) }
    }
  }
  else if (m.t === 'delta' && m.ws === active) { draft().textContent += m.text; scroll() }
  else if (m.t === 'reload' && m.ws === active) loadThread()
  else if (m.t === 'term:reset') { const t = terms.get(m.key); if (t) { t.term.reset(); t.term.write(m.data) } }
  else if (m.t === 'term:data') terms.get(m.key)?.term.write(m.data)
  else if (m.t === 'term:exit' && m.key === 'setup') checkSetup()
}

function notify(id, ev) {
  if (Notification.permission !== 'granted') return
  const w = wsById(id)
  new Notification(t(ev.is_error ? 'notify.failed' : 'notify.done', { name: w?.aiguilleur ? label(w) : w?.name ?? 'Agent' }), { body: w?.aiguilleur ? '' : w?.title ?? '' }).onclick = () => { focus(); select(id) }
}

// ---------- sidebar ----------
function renderSide() {
  $('#aiguilleur').replaceChildren(...(S.aiguilleur ? [aiguilleurItem(S.aiguilleur)] : []))
  const box = $('#repos'); box.replaceChildren(sessionsGroup())
  for (const r of S.repos) {
    const g = h('div', 'repo')
    const head = h('div', 'repoHead')
    const name = h('span', 'grow', r.name); name.title = r.path
    const plus = ibtn('plus', t('side.newWorkspace'), 'plus'); plus.title = t('side.newWorkspaceFrom', { base: r.base })
    plus.onclick = create(plus, '/workspaces', { repoId: r.id })
    const more = ibtn('more', t('side.repoOptions'))
    more.onclick = () => { showSettings(true); $(`#setRepos [data-repo="${r.id}"] select`)?.focus() }
    // the collapsed rail heads each group with the logo, or the initial when there is none (or it fails to load)
    const mark = h('span', 'repoMark', [...r.name][0]?.toUpperCase()); mark.title = r.name
    if (r.logo) { const img = h('img', 'repoLogo'); img.src = r.logo; img.alt = ''; img.title = r.name; img.onerror = () => img.replaceWith(mark); head.append(img) } else head.append(mark)
    head.append(name, more, plus); g.append(head)
    const lines = h('div', 'lines')
    lines.append(h('div', 'terminus', r.base))
    for (const w of live().filter(w => w.repoId === r.id)) lines.append(wsItem(w))
    g.append(lines)
    box.append(g)
  }
  const arch = S.workspaces.filter(w => w.archived)
  $('#archived').hidden = !arch.length
  $('#archivedList').replaceChildren(...arch.map(w => {
    const row = h('div', 'wsItem archived')
    row.append(h('span', 'grow', [w.name, w.title].filter(Boolean).join(' · ')))
    const back = ibtn('undo', t('side.restore'))
    back.onclick = guard(async () => { await api('POST', `/workspaces/${w.id}/unarchive`); select(w.id) })
    const del = ibtn('x', t('side.delete')); del.title = t('side.deleteTitle')
    del.onclick = guard(async () => { if (confirm(t(w.free ? 'side.confirmDeleteSession' : 'side.confirmDelete', { name: w.name, branch: w.branch }))) await api('DELETE', `/workspaces/${w.id}`) })
    row.oncontextmenu = e => ctxMenu(e, [[t('side.restore'), back.onclick], [t('side.deleteTitle'), del.onclick]])
    row.append(back, del); return row
  }))
  $('#empty').hidden = !!wsById(active) && !wsById(active).archived
  if (!ready) $('#empty').hidden = false
  if (settingsOpen) $('#empty').hidden = true
  $('#openSettings').classList.toggle('on', settingsOpen)
  // Remote mode, once Telegram is linked (Settings): the Mac runs on its own, Telegram gets reports and requests.
  const r = $('#remote'), on = !!S.telegram?.remote
  r.hidden = !S.telegram?.linked; r.setAttribute('aria-pressed', on); r.title = t(on ? 'side.remoteOn' : 'side.remoteOff')
}

// Known at once, before the state broadcast: the new chat's hint shows its path.
const create = (btn, path, body) => guard(async () => {
  btn.disabled = true
  try { const w = await api('POST', path, body); if (!wsById(w.id)) S.workspaces.push({ pending: [], ...w }); select(w.id) } finally { btn.disabled = false }
})

// Sessions tied to no project, right under the aiguilleur: « + » opens one, for a task that belongs to no repo.
function sessionsGroup() {
  const g = h('div', 'repo'), head = h('div', 'repoHead'), lines = h('div', 'lines')
  const mark = h('span', 'repoMark'); mark.innerHTML = svg('chat'); mark.title = t('side.sessions')
  const plus = ibtn('plus', t('side.newSessionTitle'), 'plus')
  plus.onclick = create(plus, '/sessions')
  head.append(mark, h('span', 'grow', t('side.sessions')), plus)
  lines.append(...live().filter(w => w.free).map(wsItem))
  g.append(head, lines)
  return g
}

// ---------- desktop app update (lib/update.js): downloaded in the background, one click to restart into it ----------
function renderUpdate() {
  const u = S.update ?? {}, box = $('#update')
  box.hidden = !['ready', 'manual'].includes(u.state)
  if (box.hidden) return
  const notes = h('a', null, t('update.notes')); notes.href = u.url; notes.target = '_blank'; notes.rel = 'noopener'
  const b = h('button', null, t(u.state === 'ready' ? 'update.restart' : 'update.download'))
  b.onclick = () => {
    if (u.state === 'manual') return open(u.url)
    const n = S.workspaces.filter(w => w.busy || w.tasks?.some(x => !x.shell)).length // background shells: see working() in lib/agent.js
    if (n && !confirm(t('update.busyWarning', { count: n }))) return
    b.disabled = true; b.textContent = t('update.restarting')
    api('POST', '/update').catch(() => {}) // the app quits before answering
  }
  box.replaceChildren(h('b', null, t('update.availableTitle', { version: u.latest })), notes, b)
}

// ---------- plan usage (lib/agent.js refreshUsage): session and week lanes over Settings, every limit on hover ----------
// The grey tick on a lane is the time elapsed in its window: a fill past it means you're going faster than the clock.
const WINDOW = { session: 5 * 3600_000 } // every other limit is weekly
const pct = n => new Intl.NumberFormat(lang(), { style: 'percent' }).format(n / 100)
const limitName = l => l.kind === 'session' ? t('usage.session') : l.kind === 'weekly_all' ? t('usage.week') : l.model ?? l.kind
function resetText(at) {
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000))
  if (m >= 24 * 60) return t('usage.resetsAt', { when: new Intl.DateTimeFormat(lang(), { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at) })
  return t('usage.resetsIn', { time: m < 60 ? t('usage.min', { m }) : t('usage.hm', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') }) })
}
function ago(at) {
  const m = Math.round((Date.now() - at) / 60_000), rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' })
  return m < 60 ? rtf.format(-m, 'minute') : rtf.format(-Math.round(m / 60), 'hour')
}
function renderUsage() {
  const u = S.usage, box = $('#usage'), pop = $('#usagePop')
  const lanes = ['session', 'weekly_all'].map(k => u?.limits.find(l => l.kind === k)).filter(Boolean)
  box.hidden = !lanes.length
  if (box.hidden) { pop.hidden = true; return }
  const stale = Date.now() - u.at > 15 * 60_000
  box.classList.toggle('stale', stale)
  box.replaceChildren(...lanes.map(l => {
    const lane = h('div', 'lane' + (l.pct >= 90 ? ' hot' : ''))
    const head = h('div', 'laneHead', limitName(l)); head.append(h('b', null, pct(l.pct)))
    const track = h('div', 'track'), fill = h('i'); fill.style.width = Math.min(100, l.pct) + '%'; track.append(fill)
    if (l.resetsAt) {
      const tick = h('s'); tick.style.left = Math.min(100, Math.max(0, 100 * (1 - (l.resetsAt - Date.now()) / (WINDOW[l.kind] ?? 7 * 86400_000)))) + '%'
      track.append(tick)
    }
    lane.append(head, track, h('div', 'when', l.resetsAt ? resetText(l.resetsAt) : ''))
    return lane
  }), ...(stale ? [h('div', 'when', t('usage.updated', { ago: ago(u.at) }))] : []))
  const table = h('table')
  for (const l of u.limits) {
    const tr = h('tr'); tr.append(h('td', null, limitName(l)), h('td', 'n', pct(l.pct)), h('td', 'muted', l.resetsAt ? resetText(l.resetsAt) : ''))
    table.append(tr)
  }
  const plan = u.plan ? t('usage.plan', { plan: u.plan[0].toUpperCase() + u.plan.slice(1) }) + ' · ' : ''
  pop.replaceChildren(table, h('div', 'muted', plan + t('usage.updated', { ago: ago(u.at) })))
}
{
  const box = $('#usage'), pop = $('#usagePop')
  const show = () => { const r = box.getBoundingClientRect(); pop.style.left = r.right + 18 + 'px'; pop.style.bottom = innerHeight - r.bottom + 'px'; pop.hidden = false }
  const hide = () => { pop.hidden = true }
  box.onmouseenter = box.onfocus = show; box.onmouseleave = box.onblur = hide
  setInterval(renderUsage, 60_000) // countdowns and pace ticks move with the clock
}

// ---------- first run: git, then claude, then its login; one button at a time ----------
let ready = true // assume a set-up machine until /doctor says otherwise: no flash for regular users
const STEPS = ['git', 'claude', 'login']
async function checkSetup() {
  const d = await api('GET', '/doctor').catch(() => null); if (!d) return
  const done = { git: d.git, claude: d.claude, login: d.loggedIn }
  ready = STEPS.every(s => done[s])
  const next = STEPS.find(s => !done[s])
  $('#steps').replaceChildren(...STEPS.map(s => {
    const li = h('li', done[s] ? 'done' : s === next ? 'next' : '')
    li.append(h('span', 'grow', t(`setup.${s}`)))
    if (done[s]) li.insertAdjacentHTML('afterbegin', svg('check'))
    else if (s === next) {
      const b = h('button', null, t(`setup.${s}Do`))
      b.onclick = guard(async () => {
        $('#setupTerm').hidden = false; mountTerm('setup', $('#setupTerm'))
        await api('POST', '/setup', { step: s })
      })
      li.append(b)
    }
    return li
  }))
  $('#setup').hidden = ready; $('#empty').classList.toggle('setup', !ready)
  renderSide(); renderHead()
}
$('#recheck').onclick = guard(checkSetup)

// Line number = position in the ⌘1–9 order; it also picks the line colour (8 colours, then they loop).
const live = () => [...S.workspaces.filter(w => w.free), ...S.repos.flatMap(r => S.workspaces.filter(w => w.repoId === r.id))].filter(w => !w.archived)
const lineOf = w => live().indexOf(w) + 1
const lineCls = n => 'ln' + ((n - 1) % 8 + 1)

function pillOf(w) {
  const agents = w.tasks?.filter(x => !x.shell).length ?? 0, shells = (w.tasks?.length ?? 0) - agents
  const pill = w.pending.length ? h('span', 'pill ask', t('status.ask'))
    : w.busy || agents ? h('span', 'pill run', agents ? t('status.agents', { count: agents }) : t('status.run'))
    : w.failed ? h('span', 'pill err', t('status.err'))
    : unread.has(w.id) ? h('span', 'pill new', t('status.new'))
    : shells ? h('span', 'pill shell', t('status.shells', { count: shells })) : null
  if (pill?.matches('.run, .new')) pill.prepend(h('i'))
  if (pill?.matches('.err')) pill.insertAdjacentHTML('afterbegin', svg('x'))
  return pill
}

function aiguilleurItem(c) {
  const el = h('div', 'wsItem cond' + (active === c.id && !settingsOpen ? ' on' : ''))
  const mark = h('span', 'bdg'); mark.innerHTML = svg('aiguilleur')
  const pill = pillOf(c)
  el.append(mark, h('span', 'wsName', label(c)), pill ?? h('span'), h('span', 'wsTitle', t('side.aiguilleurSub')))
  el.title = label(c) + (pill ? ' · ' + pill.textContent : '')
  el.onclick = () => select(c.id)
  return el
}

function wsItem(w) {
  const n = lineOf(w)
  const el = h('div', `wsItem ${lineCls(n)}` + (w.id === active && !settingsOpen ? ' on' : ''))
  el.append(h('span', 'bdg', n), h('span', 'wsName', label(w)))
  const pill = pillOf(w)
  el.title = label(w) + (pill ? ' · ' + pill.textContent : '') // the only label left when the sidebar is collapsed
  if (pill) el.append(pill)
  else if (w.scriptRunning) { const r = h('span', 'pill script'); r.innerHTML = svg('play'); r.append(w.scriptRunning); r.title = t('status.script', { port: w.port }); el.append(r) }
  else el.append(h('span'))
  el.append(h('span', 'wsTitle', w.title ? w.name : t(w.free ? 'side.newSession' : 'side.newWorkspace')))
  el.onclick = () => select(w.id)
  el.oncontextmenu = e => ctxMenu(e, [
    [t('head.codeTitle'), () => wsAct(w, 'open', 'code')],
    [t('head.folderTitle'), () => wsAct(w, 'open')],
    null,
    [t('head.rename'), () => renameDialog(w)],
    [t(unread.has(w.id) ? 'side.markRead' : 'side.markUnread'), () => { setUnread(w.id, !unread.has(w.id)); renderSide() }],
    !w.free && [t('side.copyBranch'), () => copy(w.branch)],
    [t('side.copyPath'), () => copy(w.path)],
    null,
    w.busy && [t('chat.stop'), () => api('POST', `/workspaces/${w.id}/interrupt`)],
    [t('head.archive'), () => wsAct(w, 'archive'), '⇧⌘A'],
  ])
  return el
}

const copy = async s => { await navigator.clipboard.writeText(s); toast(t('side.copied', { text: s })) }
// Right-click menu at the pointer: [label, fn, shortcut?] items, null for a separator, false to leave one out.
function ctxMenu(e, items) {
  e.preventDefault()
  const m = $('#ctxMenu')
  m.replaceChildren(...items.filter(i => i !== false).map(i => {
    if (!i) return h('hr')
    const b = h('button', null, i[0]); b.type = 'button'
    if (i[2]) b.append(h('kbd', null, i[2]))
    b.onclick = guard(() => { m.hidePopover(); return i[1]() })
    return b
  }))
  m.showPopover()
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 4) + 'px'
  m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 4) + 'px'
}

async function addRepoDialog() {
  const f = $('#dlgForm'); f.replaceChildren()
  const input = h('input'); input.placeholder = t('dialog.pathPlaceholder'); input.required = true
  const lab = h('label', null, t('dialog.repoPath')); lab.append(input)
  // ponytail: the server opens the picker (macOS only); elsewhere it returns nothing and the input still works
  const pick = h('button', 'ghost', t('dialog.pick')); pick.type = 'button'
  pick.onclick = guard(async () => { const { path } = await api('POST', '/pick'); if (path) { input.value = path; ok.focus() } })
  lab.append(pick)
  const list = h('div', 'suggest')
  const row = h('div', 'row')
  const cancel = h('button', 'ghost', t('dialog.cancel')); cancel.value = 'cancel'; cancel.formNoValidate = true
  const ok = h('button', null, t('dialog.add')); ok.value = 'ok'
  row.append(h('span', 'grow'), cancel, ok)
  f.append(h('h3', null, t('dialog.addRepo')), lab, list, row)
  $('#dlg').showModal()
  api('GET', '/suggest').then(paths => list.replaceChildren(...paths.map(p => {
    const b = h('button', 'ghost mono', p.replace(/^\/Users\/[^/]+/, '~')); b.type = 'button'
    b.onclick = () => { input.value = p; input.focus() }; return b
  }))).catch(() => {})
  $('#dlg').onclose = guard(async () => {
    if ($('#dlg').returnValue !== 'ok') return
    const path = input.value.trim()
    try { await api('POST', '/repos', { path }) } catch (e) {
      if (e.key !== 'errors.notRepo' || !confirm(t('dialog.initRepo', { path }))) throw e
      await api('POST', '/repos', { path, init: true })
    }
  })
}
$('#addRepo').onclick = $('#emptyAdd').onclick = addRepoDialog

// One text field in the app's dialog: resolves to the text, or null when cancelled. Never window.prompt():
// the desktop app (Electron) has none, it throws.
function ask(title, field, value, maxLength) {
  const f = $('#dlgForm'); f.replaceChildren()
  const input = h('input'); input.value = value; if (maxLength) input.maxLength = maxLength
  const lab = h('label', null, field); lab.append(input)
  const row = h('div', 'row')
  // type=button: Enter in the field submits with OK, not with the first button.
  const cancel = h('button', 'ghost', t('dialog.cancel')); cancel.type = 'button'; cancel.onclick = () => $('#dlg').close('cancel')
  const ok = h('button', null, t('dialog.ok')); ok.value = 'ok'
  row.append(h('span', 'grow'), cancel, ok)
  f.append(h('h3', null, title), lab, row)
  $('#dlg').returnValue = ''
  $('#dlg').showModal(); input.select()
  return new Promise(r => { $('#dlg').onclose = () => r($('#dlg').returnValue === 'ok' ? input.value : null) })
}
const renameDialog = guard(async w => {
  const v = await ask(t('dialog.rename'), t('dialog.name'), label(w), 80)
  if (v != null && v.trim() !== label(w)) await api('PATCH', `/workspaces/${w.id}`, { title: v })
})
$('#rename').onclick = () => { $('#moreMenu').hidePopover(); renameDialog(wsById(active)) }
$('#wsName').ondblclick = () => { if (!wsById(active)?.aiguilleur) renameDialog(wsById(active)) }

// ---------- settings: a page in place of the workspace ----------
let settingsOpen = location.hash === '#settings'
function showSettings(on) {
  settingsOpen = on; renderSettings.key = null
  if (!on && wsById(active)) return select(active)
  history.replaceState(null, '', on ? '#settings' : location.pathname)
  renderSide(); renderHead(); renderSettings()
  if (on) loadMetrics()
}
// Measures (lib/metrics.js): fetched when Settings opens, not on each state broadcast.
const money = n => new Intl.NumberFormat(lang(), { style: 'currency', currency: 'USD' }).format(n)
function loadMetrics() {
  api('GET', '/metrics?days=14').then(m => {
    const rows = !m.turns.n && !m.merges.n && !m.permissions.n && !m.pushesPerDay ? [] : [
      [t('metrics.cost'), money(m.cost.total)], [t('metrics.costAiguilleur'), money(m.cost.aiguilleur)],
      [t('metrics.turns'), m.turns.n], [t('metrics.failedTurns'), m.turns.failed],
      [t('metrics.merges'), m.merges.n], [t('metrics.conflicts'), m.merges.conflicts],
      [t('metrics.permWait'), `${Math.round(m.permissions.medianWaitMs / 1000)} s`], [t('metrics.pushes'), m.pushesPerDay]]
    $('#setMetrics').replaceChildren(...(rows.length ? rows.map(([k, v]) => { const r = h('div', 'setRow'); r.append(h('span', null, k), h('b', null, String(v))); return r })
      : [h('p', 'muted', t('metrics.empty'))]))
  }).catch(() => {})
}
function renderSettings() {
  if (!settingsOpen) return
  const d = S.defaults ?? {}
  $('#defModel').value = d.model || ''; $('#defEffort').value = d.effort || ''; $('#defMode').value = d.permissionMode || 'auto'
  // Desktop app only (lib/update.js): in the browser there is nothing to update.
  const u = S.update ?? {}
  $('#setUpdates').hidden = (u.state ?? 'off') === 'off'
  $('#autoUpdate').checked = d.autoUpdate !== false
  // What the last check found; « up to date » only after a check asked here (idle also means « not checked yet »).
  const note = { checking: t('update.checking'), downloading: t('update.downloading', { version: u.latest }), ready: t('update.readyTitle', { version: u.latest }),
    manual: t('update.availableTitle', { version: u.latest }), error: t('update.failed'), idle: checkAsked && t('update.upToDate') }[u.state]
  $('#updateNote').textContent = [t('update.version', { version: u.version }), note].filter(Boolean).join(' · ')
  $('#checkUpdate').disabled = ['checking', 'downloading', 'ready'].includes(u.state)
  renderTelegram()
  // Rebuilt only when repos change: state arrives often, and rebuilding would close an open select.
  const key = S.repos.map(r => r.id + r.base).join()
  if (key === renderSettings.key) return
  renderSettings.key = key
  $('#setRepos').replaceChildren(...S.repos.map(r => {
    const row = h('div', 'setRepo'); row.dataset.repo = r.id
    const name = h('div', 'grow'); name.append(h('b', null, r.name), h('div', 'mono muted', r.path))
    const sel = h('select'); sel.title = t('settings.baseBranch'); sel.setAttribute('aria-label', `${r.name}: ${t('settings.baseBranch')}`)
    const fill = bs => sel.replaceChildren(...bs.map(b => { const o = h('option', null, b); o.selected = b === r.base; return o }))
    fill([r.base]); api('GET', `/repos/${r.id}/branches`).then(fill).catch(() => {})
    sel.onchange = guard(() => api('PATCH', `/repos/${r.id}`, { base: sel.value }))
    const rm = h('button', 'ghost', t('settings.removeRepo'))
    rm.onclick = guard(async () => { if (confirm(t('settings.confirmRemove', { name: r.name }))) await api('DELETE', `/repos/${r.id}`) })
    row.append(name, sel, rm); return row
  }))
  if (!S.repos.length) $('#setRepos').append(h('p', 'muted', t('settings.noRepos')))
}
// Telegram (lib/remote.js info()): a token, then the one-time link that ties the user's chat to the bot.
// Rebuilt only when it changes, or a state broadcast would wipe a token being typed.
function renderTelegram() {
  const tg = S.telegram ?? {}, key = JSON.stringify(tg)
  if (key === renderTelegram.key) return
  renderTelegram.key = key
  const box = $('#setTelegram'); box.replaceChildren()
  if (!tg.on) {
    const row = h('form', 'setRow'), input = h('input', 'grow'), b = h('button', null, t('settings.telegramConnect'))
    input.type = 'password'; input.required = true; input.autocomplete = 'off'; input.placeholder = '123456:ABC-DEF…'; input.setAttribute('aria-label', t('settings.telegramToken'))
    row.onsubmit = guard(async e => { e.preventDefault(); b.disabled = true; try { await api('POST', '/telegram', { token: input.value }) } finally { b.disabled = false } })
    row.append(input, b)
    return box.append(row)
  }
  const row = h('div', 'setRow'), who = h('div', 'grow'), off = h('button', 'ghost', t('settings.telegramDisconnect'))
  who.append(h('b', null, '@' + tg.bot), tg.linked ? h('span', 'muted', ' · ' + t('settings.telegramLinked', { name: tg.chatName || '?' })) : '')
  off.onclick = guard(async () => { if (confirm(t('settings.telegramConfirmDisconnect'))) await api('POST', '/telegram', { token: '' }) })
  row.append(who, off); box.append(row)
  if (!tg.linked) {
    const step = h('div', 'setRow'), text = h('div', 'grow'), go = h('button', null, t('settings.telegramOpen'))
    text.append(h('div', null, t('settings.telegramWaiting')), h('div', 'muted', t('settings.telegramManual', { command: `/start ${tg.code}`, bot: tg.bot })))
    go.onclick = () => open(tg.link, '_blank') // the desktop app hands it to the browser, which hands it to Telegram
    step.append(text, go); box.append(step)
  }
  if (tg.error) box.append(h('p', 'err', tg.error))
}
const saveDefaults = guard(() => api('PATCH', '/defaults', { model: $('#defModel').value, effort: $('#defEffort').value, permissionMode: $('#defMode').value, autoUpdate: $('#autoUpdate').checked }))
$('#defModel').onchange = $('#defEffort').onchange = $('#defMode').onchange = $('#autoUpdate').onchange = saveDefaults
let checkAsked = false
$('#checkUpdate').onclick = guard(async () => { checkAsked = true; $('#checkUpdate').disabled = true; await api('POST', '/check-update') })
$('#openSettings').onclick = () => showSettings(true)
$('#remote').onclick = guard(async () => { const b = $('#remote'); b.disabled = true; try { await api('PATCH', '/telegram', { remote: !S.telegram?.remote }) } finally { b.disabled = false } })
$('#closeSettings').onclick = () => showSettings(false)
addEventListener('keydown', e => { if (e.key === 'Escape' && settingsOpen && !$('#dlg').open) showSettings(false) })

// ---------- workspace ----------
function select(id) {
  active = id; setUnread(id, false); settingsOpen = false
  history.replaceState(null, '', '#ws=' + id); localStorage.setItem('aig.ws', id)
  renderSide(); renderHead(); renderPerms(); renderAtts(); loadThread()
  if (solo(wsById(id))) return
  showTab(tab)
  if (tab !== 'diff') loadDiff() // the Diff tab's counts and the git bar, whatever tab is open
}

function renderHead() {
  const w = wsById(active)
  $('#settings').hidden = !settingsOpen
  $('#ws').hidden = settingsOpen || !ready || !w || !!w.archived
  if ($('#ws').hidden) return
  const c = !!w.aiguilleur
  $('#wsName').textContent = label(w)
  $('#wsBranch').textContent = `${w.branch} ← ${w.base}`; $('#wsBranch').hidden = c || w.free
  $('#wsBranch').title = w.path
  $('#wsHead .actions').hidden = c; $('#split').classList.toggle('solo', solo(w))
  const n = lineOf(w); $('#wsBranch').dataset.n = $('#tabs').dataset.n = n; $('#ws').className = c ? 'cond' : lineCls(n)
  // /model or /effort typed in the chat may pick a value the menu doesn't list (fable, a full model id…): add it.
  for (const k of ['model', 'effort']) {
    const s = $('#' + k), v = w[k] || ''
    if (![...s.options].some(o => o.value === v)) s.append(new Option(k === 'effort' ? t('head.effortLevel', { level: v }) : v, v))
    s.value = v
  }
  $('#mode').value = ['default', 'acceptEdits', 'plan'].includes(w.permissionMode) ? w.permissionMode : 'auto'
  optsSummary(); renderCtx(w.context)
  $('#busy').hidden = $('#stop').hidden = !w.busy; $('#composer').classList.toggle('busy', !!w.busy)
  $("#runPort").textContent = `http://localhost:${w.port}`; $("#runPort").href = `http://localhost:${w.port}`; $('#runPort').title = t('head.portTitle')
  document.title = (w.busy ? '● ' : '') + label(w) + ' · Aiguillage'
}

// Narrow composer: the three settings fold into one chip, « Plan · Opus · high »: permissions first (they matter
// most), then only what overrides the CLI's defaults.
function optsSummary() {
  const text = [$('#mode').selectedOptions[0]?.text.replace(/\s*\(.*\)$/, ''), $('#model').value && $('#model').selectedOptions[0].text, $('#effort').value]
    .filter(Boolean).join(' · ')
  $('#optsBtn').replaceChildren(text); $('#optsBtn').insertAdjacentHTML('beforeend', svg('down'))
}
for (const k of ['model', 'effort', 'mode']) $('#' + k).addEventListener('change', optsSummary)

// Context of the session as the terminal shows it (lib/agent.js parseContext): « 72 % until auto-compact », or
// « 28 % context used » when auto-compact is off. The ring shows that same number. Known after a first turn.
function renderCtx(c) {
  const el = $('#ctx'); el.hidden = !c?.limit // c.limit: older saved shapes wait for the next turn
  if (el.hidden) return
  const n = new Intl.NumberFormat(lang(), { notation: 'compact' }), shown = c.auto ? 100 - c.pct : c.pct
  el.style.setProperty('--p', shown); el.classList.toggle('hot', c.pct >= 90)
  el.querySelector('b').textContent = pct(shown)
  el.querySelector('span').textContent = ' ' + t(c.auto ? 'chat.contextLeft' : 'chat.contextUsed')
  el.title = t(c.auto ? 'chat.contextTokensAuto' : 'chat.contextTokens', { used: n.format(c.used), limit: n.format(c.limit) })
  el.setAttribute('aria-label', el.textContent + ' · ' + el.title); el.setAttribute('aria-valuenow', c.pct)
}
$('#model').onchange = guard(() => api('PATCH', `/workspaces/${active}`, { model: $('#model').value }))
$('#effort').onchange = guard(() => api('PATCH', `/workspaces/${active}`, { effort: $('#effort').value }))
$('#mode').onchange = guard(() => api('PATCH', `/workspaces/${active}`, { permissionMode: $('#mode').value }))
$('#stop').onclick = guard(() => api('POST', `/workspaces/${active}/interrupt`))

// Open / Archive live in the header menus (and a session's right-click menu), Commit / Merge / PR in the Diff tab's bar.
async function wsAct(w, act, app) {
  let body = { app }
  if (act === 'archive' && !confirm(t(w.free ? 'head.confirmArchiveSession' : 'head.confirmArchive', { name: w.name, branch: w.branch }))) return
  if (act === 'merge' && !confirm(t('head.confirmMerge', { branch: w.branch, base: w.base }))) return
  if (act === 'commit') { const m = await ask(t('head.commit'), t('head.commitPrompt'), w.title || ''); if (m == null) return; body = { message: m } }
  const r = await api('POST', `/workspaces/${w.id}/${act}`, body)
  if (r.message) toast(r.message)
  if (act === 'archive') { if (w.id === active) active = null; renderSide(); renderHead() } else if (w.id === active) loadDiff()
}
const onAct = guard(async e => {
  const b = e.target.closest('button[data-act]'); if (!b) return
  b.closest('[popover]')?.hidePopover()
  b.disabled = true
  try { await wsAct(wsById(active), b.dataset.act, b.dataset.app) } finally { b.disabled = false }
})
for (const el of [$('#wsHead .actions'), $('#gitBar')]) el.addEventListener('click', onAct)

// ---------- chat ----------
let toolEls = new Map()
const thread = $('#thread')
// A chat image opens full size; a click anywhere or Escape closes it.
thread.addEventListener('click', e => { const i = e.target.closest('img.media, .att:has(img)'); if (!i) return; const img = i.querySelector('img') ?? i, z = $('#zoom'); z.firstChild.src = img.src; z.firstChild.alt = img.alt || i.title; z.showModal() })
$('#zoom').onclick = () => $('#zoom').close()
const scroll = () => { const t = thread; if (t.scrollHeight - t.scrollTop - t.clientHeight < 300) t.scrollTop = t.scrollHeight }
const draft = () => thread.querySelector('.draft') ?? thread.appendChild(h('div', 'msg ai draft'))
const dropDraft = () => thread.querySelector('.draft')?.remove()

async function loadThread() {
  thread.replaceChildren(); toolEls = new Map()
  if (!active) return
  const id = active
  const evs = await api('GET', `/workspaces/${id}/log`).catch(() => [])
  if (id !== active) return
  thread.replaceChildren(); toolEls = new Map()
  if (!evs.length) { const p = h('div', 'hint'); p.innerHTML = t(wsById(id)?.aiguilleur ? 'chat.aiguilleurReady' : wsById(id)?.free ? 'chat.sessionReady' : 'chat.ready', { path: wsById(id)?.path ?? '', interpolation: { escapeValue: true } }); thread.append(p) }
  evs.forEach(renderEv)
  renderTasks()
  thread.scrollTop = thread.scrollHeight
}

const rel = p => { const w = wsById(active); return w && typeof p === 'string' && p.startsWith(w.path + '/') ? p.slice(w.path.length + 1) : p }
function toolSummary(name, i = {}) {
  return i.command ?? rel(i.file_path ?? i.notebook_path) ?? i.pattern ?? i.description ?? i.url ?? i.query ?? i.skill ?? Object.values(i).find(v => typeof v === 'string') ?? ''
}

function renderEv(ev) {
  if (ev.type === 'cg_user') {
    const m = h('div', 'msg me'), body = h('div', 'body', ev.text)
    if (ev.via === 'telegram') { m.classList.add('via'); m.title = t('chat.viaTelegram'); m.dataset.via = '📱' }
    if (ev.files?.length) { const l = h('div', 'atts'); l.append(...ev.files.map(fileChip)); body.append(l) }
    m.append(body)
    if (ev.cp) {
      const b = ibtn('undo', t('chat.revert'), 'revert'); b.title = t('chat.revertTitle')
      b.onclick = guard(async () => {
        if (!confirm(t('chat.confirmRevert'))) return
        const r = await api('POST', `/workspaces/${active}/revert`, { msgId: ev.id })
        $('#input').value = r.text; atts.set(active, r.files.map(f => ({ ...f, ready: null }))); renderAtts()
        $('#input').focus(); loadDiff()
      })
      m.append(b)
    }
    return thread.append(m)
  }
  if (ev.type === 'cg_clear') {
    thread.querySelectorAll('.revert').forEach(b => b.remove()) // the server refuses those now
    return thread.append(h('div', 'meta cleared', t('chat.cleared')))
  }
  if (ev.type === 'system') return thread.append(h('div', 'meta', `session ${ev.session_id.slice(0, 8)} · ${ev.model}`))
  if (ev.type === 'cg_error') return thread.append(h('div', 'msg err', ev.key ? t(ev.key, ev.vars) : ev.text))
  // An agent's finished turn, in the aiguilleur's conversation (lib/remote.js): its project / workspace, then its words.
  if (ev.type === 'cg_report') {
    const wait = ev.ok && (ev.status === 'blocked' || ev.status === 'decision')
    const m = h('div', 'msg report' + (ev.ok ? '' : ' bad') + (wait ? ' wait' : '')), head = h('button', 'ghost head')
    head.insertAdjacentHTML('afterbegin', svg(!ev.ok ? 'x' : wait ? 'pause' : 'check')); head.append(h('span', null, ev.label))
    head.title = t('chat.openReport'); head.disabled = !wsById(ev.ws) || wsById(ev.ws).archived
    head.onclick = () => select(ev.ws)
    m.append(head)
    if (ev.text) m.append(md(ev.text))
    return thread.append(m)
  }
  if (ev.type === 'task') {
    // Stopped is a choice, not a failure: a filled station and a word, red only when it broke.
    const b = toolEls.get(ev.tool_use_id)
    b?.classList.add('done'); if (ev.status === 'failed') b?.classList.add('bad')
    if (ev.status === 'stopped') b?.querySelector('.sub').append(h('div', 'meta', t('chat.subagentStopped')))
    return renderTasks()
  }
  if (ev.type === 'result') {
    const m = h('div', 'meta ' + (ev.is_error ? 'bad' : 'ok'), `${Math.round(ev.duration_ms / 1000)}s · ${t('chat.turns', { count: ev.num_turns })}`)
    m.insertAdjacentHTML('afterbegin', svg(ev.is_error ? 'x' : 'check'))
    thread.append(m)
    if (ev.error) thread.append(h('div', 'msg err', ev.error))
    return
  }
  const content = ev.message?.content
  const parent = ev.parent_tool_use_id && toolEls.get(ev.parent_tool_use_id)?.querySelector('.sub')
  const into = parent || thread
  if (typeof content === 'string') return into.append(h('div', 'meta', content))
  for (const c of content ?? []) {
    if (c.type === 'text' && ev.type === 'assistant') {
      const m = h('div', 'msg ai' + (parent ? ' small' : '')); m.append(md(c.text)); into.append(m)
      // A full-screen command the CLI has no -p version of: offer the real Claude Code, on this conversation.
      const cmd = !parent && c.text.match(/^(\/[\w:.-]+) isn't available in this environment\.?$/)?.[1]
      if (cmd) {
        m.replaceChildren(h('p', null, t('chat.interactiveOnly', { cmd })))
        const b = h('button', 'ghost', t('chat.openInTerminal', { cmd }))
        b.onclick = guard(async () => { await api('POST', `/workspaces/${active}/terminal-command`, { command: cmd }); showTab('term') })
        m.append(b)
      }
    } else if (c.type === 'text') into.append(h('div', 'meta', c.text))
    else if (c.type === 'tool_use') into.append(toolEl(c))
    else if (c.type === 'tool_result') {
      const t = toolEls.get(c.tool_use_id); if (!t) continue
      const text = c.content ?? '' // already text, cut by the server (lib/agent.js trim)
      const out = t.querySelector('.out'); out.textContent = text
      out.hidden = !text
      if (c.is_error) t.classList.add('bad')
      t.classList.add('done')
    }
  }
}

function toolEl(c) {
  const d = h('details', 'tool' + (c.name === 'Agent' || c.name === 'Task' ? ' agent' : ''))
  const s = h('summary')
  s.append(h('b', null, c.name), h('span', 'mono', ' ' + String(toolSummary(c.name, c.input)).split('\n')[0].slice(0, 160)))
  d.append(s)
  const i = c.input ?? {}
  if (c.name === 'TodoWrite' && Array.isArray(i.todos)) {
    const ul = h('ul', 'todos')
    for (const t of i.todos) ul.append(h('li', t.status, t.content))
    d.append(ul); d.open = true
  } else if (c.name === 'Edit' || c.name === 'MultiEdit') {
    const pre = h('pre', 'diff')
    for (const e of i.edits ?? [i]) {
      for (const l of String(e.old_string ?? '').split('\n')) pre.append(h('div', 'del', '- ' + l))
      for (const l of String(e.new_string ?? '').split('\n')) pre.append(h('div', 'add', '+ ' + l))
    }
    d.append(pre)
  } else if (c.name === 'Read' && IMAGE.test(i.file_path ?? '')) {
    // The image the agent looked at (its base64 isn't kept: lib/agent.js trim), read again from disk.
    const img = h('img', 'media'); img.src = mediaUrl(i.file_path); img.alt = rel(i.file_path); d.append(img)
  } else if (c.name !== 'Read') d.append(h('pre', null, typeof i.command === 'string' ? i.command : JSON.stringify(i, null, 2)))
  if (typeof i.command === 'string') d.dataset.cmd = i.command // a background shell's row shows it
  const out = h('pre', 'out'); out.hidden = true
  d.append(out, h('div', 'sub'))
  toolEls.set(c.id, d)
  if (wsById(active)?.tasks?.some(x => x.id === c.id)) d.classList.add('running')
  return d
}

// Subagents still working and shells left running in the background, over the composer: each opens its block in the
// thread, where its messages and tools land, and can be stopped alone. The row stays until the CLI confirms; meanwhile its stop button waits.
const stopping = new Set()
function renderTasks() {
  const tasks = wsById(active)?.tasks ?? [], box = $('#tasks')
  const ids = new Set(tasks.map(x => x.id))
  for (const [id, el] of toolEls) el.classList.toggle('running', ids.has(id))
  box.hidden = !tasks.length
  if (box.hidden) { box.replaceChildren(); return scroll() }
  const shells = tasks.filter(x => x.shell).length, agents = tasks.length - shells
  const head = [agents && t('chat.subagents', { count: agents }), shells && t('chat.shells', { count: shells })].filter(Boolean).join(' · ')
  box.replaceChildren(h('div', 'tasksHead', head), ...tasks.map(x => {
    const cmd = x.shell && toolEls.get(x.id)?.dataset.cmd
    const row = h('div', 'task' + (x.shell ? ' shell' : '')), name = x.description || cmd || x.type
    const b = h('button', 'open')
    b.append(h('i'), h('b', null, name), h('span', 'mono', x.last || cmd || x.type))
    b.title = [x.type, x.description, cmd || x.last].filter(Boolean).join(' · ')
    b.onclick = () => {
      const el = toolEls.get(x.id); if (!el) return
      el.open = true; el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    // Words, like the composer's Stop: a lone square in a list reads as a checkbox.
    const s = h('button', 'stop', t('chat.stop')); s.title = t('chat.stopSubagent', { name }); s.setAttribute('aria-label', s.title)
    s.disabled = stopping.has(x.id)
    s.onclick = guard(async () => {
      stopping.add(x.id); s.disabled = true
      try { await api('POST', `/workspaces/${active}/stop-task`, { id: x.id }) } catch (e) { stopping.delete(x.id); s.disabled = false; throw e }
    })
    row.append(b, s)
    return row
  }))
  scroll() // the strip takes room from the thread: keep its end in view, like new events do
}

const permQ = text => { const q = h('div', 'q'); q.append(h('span', 'bdg', '!'), h('span', null, text)); return q }
function renderPerms() {
  const w = wsById(active), box = $('#perms')
  box.replaceChildren()
  for (const p of w?.pending ?? []) {
    const plan = p.tool === 'ExitPlanMode'
    const card = h('div', 'perm')
    if (plan) {
      card.append(permQ(t('perm.proposesPlan')))
      const body = h('div', 'msg ai plan'); body.append(md(p.input.plan)); card.append(body)
    } else {
      card.append(permQ(t('perm.wantsTool', { tool: p.tool })), h('pre', null, String(toolSummary(p.tool, p.input) || JSON.stringify(p.input, null, 2))))
    }
    const row = h('div', 'row')
    const no = h('button', 'ghost', t(plan ? 'perm.denyPlan' : 'perm.deny'))
    const yes = h('button', null, t(plan ? 'perm.approvePlan' : 'perm.allow'))
    no.onclick = guard(async () => {
      const message = plan ? await ask(t('perm.denyPlan'), t('perm.planFeedback'), '') : undefined
      if (plan && message == null) return
      await api('POST', `/workspaces/${active}/permission`, { id: p.id, allow: false, message })
    })
    yes.onclick = guard(() => api('POST', `/workspaces/${active}/permission`, { id: p.id, allow: true }))
    row.append(h('span', 'grow'), no, yes); card.append(row); box.append(card)
  }
}

$('#composer').onsubmit = guard(async e => {
  e.preventDefault()
  const id = active, text = $('#input').value.trim(), list = attsOf(id)
  if (!id || (!text && !list.length)) return
  if (Notification.permission === 'default') Notification.requestPermission()
  // Cleared right away so a second Enter can't send twice; uploads still running are awaited.
  $('#input').value = ''; atts.set(id, []); renderAtts()
  await Promise.all(list.map(f => f.ready))
  const files = list.filter(f => f.path)
  if (!text && !files.length) return
  try { await api('POST', `/workspaces/${id}/send`, { text, files: files.map(f => f.path) }) } catch (err) {
    $('#input').value = text; atts.set(id, files); renderAtts(); throw err
  }
})
$('#input').onkeydown = e => {
  if (!$('#slash').hidden && slashKey(e)) return e.preventDefault()
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit() }
}

// ---------- « / » menu: the commands the session itself offers (lib/agent.js commands), filtered as you type ----------
const cmds = new Map() // workspace id -> Promise<[{ name, description, hint, aliases }]>; dropped after each turn (new skills…)
const cmdsOf = id => cmds.get(id) ?? cmds.set(id, api('GET', `/workspaces/${id}/commands`).catch(() => { cmds.delete(id); return [] })).get(id)
let slash = [], slashAt = 0, slashOff = null // slashOff: the text Escape closed the menu on
async function renderSlash() {
  const v = $('#input').value, q = v.match(/^\/(\S*)$/)?.[1]?.toLowerCase(), id = active
  const all = q == null || !id || v === slashOff ? [] : await cmdsOf(id)
  if (id !== active || $('#input').value !== v) return
  const starts = c => [c.name, ...c.aliases].some(n => n.toLowerCase().startsWith(q))
  slash = [...all.filter(starts), ...all.filter(c => !starts(c) && c.name.toLowerCase().includes(q))]
  slashAt = 0; paintSlash()
}
function paintSlash() {
  const box = $('#slash'), input = $('#input')
  box.hidden = !slash.length
  box.replaceChildren(...slash.map((c, i) => {
    const o = h('div', i === slashAt ? 'on' : ''); o.id = 'slash-' + i; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', i === slashAt)
    o.append(h('b', null, '/' + c.name)); if (c.hint) o.append(h('i', null, c.hint)); o.append(h('span', null, c.description)); o.title = c.description
    o.onmousedown = e => { e.preventDefault(); slashAt = i; pickSlash() }
    return o
  }))
  if (slash.length) { input.setAttribute('aria-activedescendant', 'slash-' + slashAt); box.children[slashAt].scrollIntoView({ block: 'nearest' }) }
  else input.removeAttribute('aria-activedescendant')
}
// Tab completes; Enter completes and sends, unless the command takes arguments still to type.
function pickSlash(send) {
  const c = slash[slashAt]; $('#input').value = `/${c.name} `; slash = []; paintSlash(); $('#input').focus()
  if (send && !c.hint) $('#composer').requestSubmit()
}
function slashKey(e) {
  const d = { ArrowDown: 1, ArrowUp: -1 }[e.key]
  if (d) { slashAt = (slashAt + d + slash.length) % slash.length; paintSlash(); return true }
  if (e.key === 'Escape') { slashOff = $('#input').value; slash = []; paintSlash(); return true }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { pickSlash(e.key === 'Enter'); return true }
}
$('#input').addEventListener('input', renderSlash)
$('#input').addEventListener('blur', () => { slash = []; paintSlash() })

// ---------- attachments: drop anywhere on the window, paste, or the paperclip. Any file type. ----------
const MAX_FILE = 100e6 // same cap as the server
const atts = new Map() // workspace id -> [{ name, path, url?, ready }] (path once uploaded)
const attsOf = id => atts.get(id) ?? atts.set(id, []).get(id)
function fileChip(f) {
  const c = h('span', 'att'); c.title = f.name
  if (f.url) { const i = h('img'); i.src = f.url; i.alt = ''; c.append(i) } else c.innerHTML = svg('file')
  c.append(h('span', 'name', f.name))
  return c
}
function renderAtts() {
  const list = active ? attsOf(active) : [], box = $('#atts')
  box.hidden = !list.length
  box.replaceChildren(...list.map(f => {
    const c = fileChip(f); c.classList.toggle('loading', !f.path)
    const x = ibtn('x', t('chat.remove', { name: f.name }), 'rm')
    x.onclick = () => { list.splice(list.indexOf(f), 1); renderAtts(); $('#input').focus() }
    c.append(x); return c
  }))
}
// Uploaded as soon as attached, like other chat apps: sending is then instant.
function addFiles(files) {
  const id = active; if (!id) return
  for (const file of files) {
    if (file.size > MAX_FILE) { toast(t('chat.tooLarge', { name: file.name }), true); continue }
    const f = { name: file.name }
    f.ready = fetch(`/api/workspaces/${id}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.key ? t(j.key, j.vars) : j.error || r.statusText); Object.assign(f, j) })
      .catch(e => { const l = attsOf(id); if (l.includes(f)) l.splice(l.indexOf(f), 1); toast(`${file.name}: ${e.message}`, true) })
      .finally(() => { if (id === active) renderAtts() })
    attsOf(id).push(f)
  }
  renderAtts()
}
$('#attach').innerHTML = svg('clip')
$('#attach').onclick = () => $('#fileInput').click()
$('#fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; $('#input').focus() }
// Screenshots pasted in the composer. Cells copied from a spreadsheet also carry a picture: text wins.
$('#input').onpaste = e => {
  const d = e.clipboardData
  if (!d.files.length || d.types.includes('text/plain')) return
  e.preventDefault(); addFiles([...d.files])
}
// The whole window is the drop zone. Dragover is always cancelled for files, so a miss never opens the file in the window.
const dragsFiles = e => e.dataTransfer?.types.includes('Files')
const canDrop = () => !!active && !$('#ws').hidden
addEventListener('dragenter', e => { if (dragsFiles(e) && canDrop()) $('#drop').hidden = false })
addEventListener('dragover', e => { if (dragsFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none' } })
addEventListener('dragleave', e => { if (!e.relatedTarget) $('#drop').hidden = true })
addEventListener('drop', e => {
  if (!dragsFiles(e)) return
  e.preventDefault(); $('#drop').hidden = true
  if (!canDrop()) return
  const items = [...e.dataTransfer.items].filter(i => i.kind === 'file')
  const isDir = i => items[i]?.webkitGetAsEntry?.()?.isDirectory
  const files = [...e.dataTransfer.files].filter((_, i) => !isDir(i))
  if (files.length < e.dataTransfer.files.length) toast(t('chat.noFolders'), true)
  addFiles(files); $('#input').focus()
})

// ---------- right panel ----------
// The Terminal tab shows the interactive Claude Code while one runs (see terminal-command), the shell otherwise.
const termKey = () => `${active}:${wsById(active)?.claudeTerm ? 'claude' : 'shell'}`
let termShown = null
function showTab(t) {
  tab = t; localStorage.setItem('aig.tab', t)
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === t)
  $('#diffTab').hidden = t !== 'diff'; $('#termView').hidden = t !== 'term'; $('#runView').hidden = t !== 'run'
  $('#refresh').hidden = t !== 'diff'
  if (!active) return
  if (t === 'diff') loadDiff()
  if (t === 'term') mountTerm(termKey(), $('#termView'))
  if (t === 'run') { mountTerm(`${active}:script`, $('#runTerm')); loadScripts() }
}
$('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab) }
$('#refresh').onclick = () => loadDiff()
$('#runStart').onclick = guard(() => api('POST', `/workspaces/${active}/run`, { id: $('#runScript').value }))
async function loadScripts() {
  const { run, default: def } = await api('GET', `/workspaces/${active}/scripts`).catch(() => ({ run: {} }))
  const sel = $('#runScript')
  sel.replaceChildren(...Object.entries(run).map(([id, r]) => { const o = h('option', null, id); o.value = id; o.title = r.command; o.selected = id === def; return o }))
  sel.hidden = !sel.options.length
  $('#runAsk').hidden = !sel.hidden
}
// Unrecognized project: let the agent figure out the command and write .aiguillage/settings.toml.
$('#runAsk').onclick = guard(() => api('POST', `/workspaces/${active}/send`, { text: t('panel.askAgentPrompt') }))
$('#runStop').onclick = guard(() => api('POST', `/workspaces/${active}/run-stop`))

async function loadDiff() {
  const id = active
  const { diff, status } = await api('GET', `/workspaces/${id}/diff`).catch(e => ({ diff: '', status: e.message }))
  if (id !== active) return
  const box = $('#diffView'); box.replaceChildren()
  const files = diff.split(/^(?=diff --git )/m).filter(Boolean)
  let adds = 0, dels = 0
  // Nothing to ship: Merge and PR wait for a change, Commit for an uncommitted one.
  $('#gitBar [data-act="commit"]').disabled = !status
  for (const a of ['merge', 'pr']) $(`#gitBar [data-act="${a}"]`).disabled = !files.length
  const counts = el => { if (files.length) el.append(h('span', 'add', `+${adds}`), h('span', 'del', ` −${dels}`)) }
  const stat = () => {
    $('#diffStat').replaceChildren(); $('#diffCount').replaceChildren(); counts($('#diffCount'))
    if (files.length) { $('#diffStat').append(h('b', null, t('panel.files', { count: files.length })), ' '); counts($('#diffStat')) }
  }
  if (!files.length) { stat(); return box.append(h('div', 'hint', t('panel.noChanges'))) }
  const sum = h('div', 'files')
  for (const f of files) {
    const name = (f.match(/^\+\+\+ b\/(.*)$/m) ?? f.match(/^--- a\/(.*)$/m) ?? f.match(/^diff --git a\/(.*?) b\//))?.[1] ?? '?'
    // Only lines after the first @@ are content: a removed "-- comment" line must not pass for a header.
    const hunks = f.includes('\n@@') ? f.slice(f.indexOf('\n@@')) : ''
    const add = (hunks.match(/^\+/gm) ?? []).length, del = (hunks.match(/^-/gm) ?? []).length
    adds += add; dels += del
    const sec = h('details', 'file'); sec.open = files.length < 15
    const s = h('summary'); s.append(h('span', 'mono grow', name), h('span', 'add', `+${add}`), h('span', 'del', ` −${del}`))
    const pre = h('pre', 'diff')
    for (const l of hunks.slice(1).split('\n')) { // headers end at the first hunk
      pre.append(h('div', l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : '', l))
    }
    sec.append(s, pre); box.append(sec)
    const jump = h('div', 'mono'); jump.append(h('span', 'grow', name), h('span', 'add', `+${add}`), h('span', 'del', ` −${del}`))
    jump.onclick = () => { sec.open = true; sec.scrollIntoView({ block: 'start' }) }
    sum.append(jump)
  }
  if (files.length > 1) box.prepend(sum)
  if (status) box.prepend(h('div', 'hint', t('panel.uncommitted')))
  stat()
}

const terms = new Map()
function mountTerm(key, host) {
  for (const [k, t] of terms) if (k !== key && !k.startsWith(active + ':')) { t.term.dispose(); terms.delete(k) }
  let t = terms.get(key)
  if (!t) {
    const el = h('div', 'xterm-host')
    const term = new Terminal({ fontSize: 12.5, fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", fontWeight: 400, cursorBlink: true, theme: termTheme() })
    const fit = new FitAddon(); term.loadAddon(fit)
    term.onData(data => send({ t: 'term:in', key, data }))
    term.onResize(({ cols, rows }) => send({ t: 'term:resize', key, cols, rows }))
    t = { term, fit, el }; terms.set(key, t)
    term.open(el)
    send({ t: 'term:open', key })
  }
  host.replaceChildren(t.el)
  if (host.id === 'termView') termShown = key
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus() })
}
// xterm needs resolved colours: a probe turns the light-dark() tokens into rgb().
const cssColor = v => { const p = document.body.appendChild(h('i')); p.style.color = `var(${v})`; const c = getComputedStyle(p).color; p.remove(); return c }
// ANSI colours tuned per ground (>= 4.5:1 on --term-bg); xterm's defaults are built for black and wash out on white.
const ANSI = {
  light: { black: '#1a1a1a', red: '#b80016', green: '#006b41', yellow: '#7f5a00', blue: '#003ca6', magenta: '#a0006e', cyan: '#00696f', white: '#5d646b',
    brightBlack: '#5d646b', brightRed: '#c2001a', brightGreen: '#00754a', brightYellow: '#8a6200', brightBlue: '#2453b8', brightMagenta: '#b0247a', brightCyan: '#007a80', brightWhite: '#1a1a1a' },
  dark: { black: '#2a2f35', red: '#ff8b95', green: '#6fd3a0', yellow: '#ffcd00', blue: '#86a8ff', magenta: '#e19bdf', cyan: '#6ccfd6', white: '#c9cdd2',
    brightBlack: '#9aa1a9', brightRed: '#ffa8b0', brightGreen: '#8fe0b6', brightYellow: '#ffe066', brightBlue: '#a6c0ff', brightMagenta: '#eab3e8', brightCyan: '#8fdde3', brightWhite: '#ffffff' },
}
const termTheme = () => ({ ...ANSI[isDark() ? 'dark' : 'light'], background: cssColor('--term-bg'), foreground: cssColor('--fg'), cursor: cssColor('--fg'), selectionBackground: cssColor('--line') })
const retheme = () => { for (const t of terms.values()) t.term.options.theme = termTheme() }
// Theme: /theme.js already applied the stored choice; 'system' removes data-theme and lets the OS decide.
const osDark = matchMedia('(prefers-color-scheme: dark)')
osDark.addEventListener('change', retheme)
const theme = () => document.documentElement.dataset.theme || 'system'
const isDark = () => theme() === 'dark' || (theme() === 'system' && osDark.matches)
function setTheme(v) {
  if (v === 'system') { localStorage.removeItem('aig.theme'); delete document.documentElement.dataset.theme }
  else { localStorage.setItem('aig.theme', v); document.documentElement.dataset.theme = v }
  retheme()
}
new ResizeObserver(() => { for (const t of terms.values()) if (t.el.isConnected) t.fit.fit() }).observe($('#panel'))

// ---------- layout: sidebar collapsed to badges, panel beside or below the chat, draggable split; all remembered ----------
const root = document.documentElement, split = $('#split'), gutter = $('#gutter')
const narrow = matchMedia('(max-width: 900px)') // too narrow for side by side: always below
const sizes = JSON.parse(localStorage.getItem('aig.split') || '{}') // panel share of #split, per orientation
let below = false
const setIcon = (b, icon, text) => { b.innerHTML = svg(icon); b.title = text; b.setAttribute('aria-label', text) }
function layout() {
  const min = root.classList.contains('side-min')
  setIcon($('#sideToggle'), 'side', t(min ? 'side.expand' : 'side.collapse')); $('#sideToggle').setAttribute('aria-expanded', !min)
  below = narrow.matches || localStorage.getItem('aig.layout') === 'below'
  split.classList.toggle('below', below)
  $('#layout').hidden = narrow.matches
  setIcon($('#layout'), below ? 'panelRight' : 'panelBelow', t(below ? 'panel.right' : 'panel.below'))
  gutter.setAttribute('aria-orientation', below ? 'horizontal' : 'vertical')
  const f = sizes[below ? 'below' : 'side']
  split.style.setProperty('--panel-size', f ? f * 100 + '%' : '') // none: the CSS default
}
function resize(f) {
  const r = split.getBoundingClientRect(), total = below ? r.height : r.width
  f = Math.min(Math.max(f, 200 / total), 1 - 240 / total) // the panel keeps 200px, the chat 240px
  sizes[below ? 'below' : 'side'] = f; split.style.setProperty('--panel-size', f * 100 + '%')
}
const saveSizes = () => localStorage.setItem('aig.split', JSON.stringify(sizes))
gutter.onpointerdown = e => { e.preventDefault(); gutter.setPointerCapture(e.pointerId); gutter.classList.add('drag') }
gutter.onpointermove = e => {
  if (!gutter.hasPointerCapture(e.pointerId)) return
  const r = split.getBoundingClientRect()
  resize(below ? (r.bottom - e.clientY) / r.height : (r.right - e.clientX) / r.width)
}
gutter.onlostpointercapture = () => { gutter.classList.remove('drag'); saveSizes() }
gutter.ondblclick = () => { delete sizes[below ? 'below' : 'side']; saveSizes(); layout() }
gutter.onkeydown = e => {
  const d = { ArrowLeft: .02, ArrowUp: .02, ArrowRight: -.02, ArrowDown: -.02 }[e.key]; if (!d) return
  e.preventDefault()
  const r = split.getBoundingClientRect(), p = $('#panel').getBoundingClientRect()
  resize((below ? p.height / r.height : p.width / r.width) + d); saveSizes()
}
$('#sideToggle').onclick = () => {
  if (root.classList.toggle('side-min')) localStorage.setItem('aig.sideMin', '1'); else localStorage.removeItem('aig.sideMin')
  layout()
}
$('#layout').onclick = () => { localStorage.setItem('aig.layout', below ? 'side' : 'below'); layout() }
narrow.addEventListener('change', layout)

// ---------- keyboard ----------
addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey)) return
  const l = live()
  if (/^[1-9]$/.test(e.key) && l[e.key - 1]) { e.preventDefault(); select(l[e.key - 1].id) }
  const w = wsById(active)
  if (e.shiftKey && e.key.toLowerCase() === 'a' && w && !w.archived && !w.aiguilleur && !settingsOpen && !$('#dlg').open) { e.preventDefault(); guard(wsAct)(w, 'archive') }
})

translateDom()
for (const o of $('#effort').options) o.textContent = o.value ? t('head.effortLevel', { level: o.value }) : t('head.effortDefault')
$('#lang').replaceChildren(...Object.entries(LANGS).map(([code, name]) => { const o = h('option', null, name); o.value = code; o.selected = code === lang(); return o }))
$('#langRow').hidden = $('#lang').options.length < 2
// New-workspace defaults offer the same choices as the header.
for (const k of ['Model', 'Effort', 'Mode']) $('#def' + k).append(...[...$('#' + k.toLowerCase()).options].map(o => o.cloneNode(true)))
$('#closeSettings').innerHTML = svg('x')
$('#openSettings').insertAdjacentHTML('afterbegin', svg('gear'))
$('#remote').insertAdjacentHTML('afterbegin', svg('phone'))
$('#lang').onchange = async () => { await setLang($('#lang').value); location.reload() }
$('#theme').value = theme()
$('#theme').onchange = () => setTheme($('#theme').value)

// Desktop app: the window has no title bar, so the sheet makes room for the traffic lights and drags the window.
if (/Electron\//.test(navigator.userAgent)) document.documentElement.classList.add('electron')
$('#refresh').innerHTML = svg('refresh')
$('#moreBtn').innerHTML = svg('more')
$('#openBtn').insertAdjacentHTML('beforeend', svg('down'))
$('#runStart').insertAdjacentHTML('afterbegin', svg('play'))
$('#runStop').insertAdjacentHTML('afterbegin', svg('stop'))
for (const b of [$('#addRepo'), $('#emptyAdd')]) { b.replaceChildren(h('span', null, t('side.addRepo'))); b.title = t('side.addRepo'); b.classList.add('ico'); b.insertAdjacentHTML('afterbegin', svg('plus')) }
layout()

connect()
api('GET', '/state').then(s => { S = s; if (settingsOpen) showSettings(true); else { renderSide(); if (wsById(active)) select(active) } })
checkSetup()
