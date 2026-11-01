import { marked } from '/vendor/marked.js'
import DOMPurify from '/vendor/purify.js'
import { Terminal } from '/vendor/xterm.js'
import { FitAddon } from '/vendor/addon-fit.js'
import { t, LANGS, lang, setLang, translateDom } from '/i18n.js'

const $ = s => document.querySelector(s)
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const md = s => DOMPurify.sanitize(marked.parse(s || ''))
// One small icon set, same 16px grid and stroke.
const ICONS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H7"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  edit: '<path d="M10.5 3 13 5.5 6 12.5H3.5V10z"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
}
const svg = n => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`
const ibtn = (n, label, cls = '') => { const b = h('button', 'ghost icon ' + cls); b.innerHTML = svg(n); b.title = label; b.setAttribute('aria-label', label); return b }

let S = { repos: [], workspaces: [] }
let active = new URLSearchParams(location.hash.slice(1)).get('ws')
let tab = 'diff'
const unread = new Set()
const wsById = id => S.workspaces.find(w => w.id === id)
// Shown name: the task name (Claude's summary of the first message, or the user's rename), else the city.
const label = w => w.title || w.name

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
  if (m.t === 'state') { S = m; renderSide(); renderHead(); renderPerms(); renderSettings() }
  else if (m.t === 'ev') {
    if (m.ws === active) { dropDraft(); renderEv(m.ev); scroll() }
    if (m.ev.type === 'result') {
      if (m.ws === active && tab === 'diff') loadDiff()
      if (m.ws === active && tab === 'run') loadScripts()
      if (m.ws !== active || document.hidden) { unread.add(m.ws); renderSide(); notify(m.ws, m.ev) }
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
  new Notification(t(ev.is_error ? 'notify.failed' : 'notify.done', { name: w?.name ?? 'Agent' }), { body: w?.title ?? '' }).onclick = () => { focus(); select(id) }
}

// ---------- sidebar ----------
function renderSide() {
  const box = $('#repos'); box.replaceChildren()
  for (const r of S.repos) {
    const g = h('div', 'repo')
    const head = h('div', 'repoHead')
    const name = h('span', 'grow', r.name); name.title = r.path
    const plus = ibtn('plus', t('side.newWorkspace')); plus.title = t('side.newWorkspaceFrom', { base: r.base })
    plus.onclick = guard(async () => { plus.disabled = true; try { select((await api('POST', '/workspaces', { repoId: r.id })).id) } finally { plus.disabled = false } })
    const more = ibtn('more', t('side.repoOptions'))
    more.onclick = () => { showSettings(true); $(`#setRepos [data-repo="${r.id}"] select`)?.focus() }
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
    del.onclick = guard(async () => { if (confirm(t('side.confirmDelete', { name: w.name, branch: w.branch }))) await api('DELETE', `/workspaces/${w.id}`) })
    row.append(back, del); return row
  }))
  $('#empty').hidden = !!wsById(active) && !wsById(active).archived
  if (!S.repos.length || !ready) $('#empty').hidden = false
  if (settingsOpen) $('#empty').hidden = true
  $('#openSettings').classList.toggle('on', settingsOpen)
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
const live = () => S.repos.flatMap(r => S.workspaces.filter(w => w.repoId === r.id && !w.archived))
const lineOf = w => live().indexOf(w) + 1
const lineCls = n => 'ln' + ((n - 1) % 8 + 1)

function wsItem(w) {
  const n = lineOf(w)
  const el = h('div', `wsItem ${lineCls(n)}` + (w.id === active && !settingsOpen ? ' on' : ''))
  el.append(h('span', 'bdg', n), h('span', 'wsName', label(w)))
  const pill = w.pending.length ? h('span', 'pill ask', t('status.ask'))
    : w.busy ? h('span', 'pill run', t('status.run'))
    : w.failed ? h('span', 'pill err', t('status.err'))
    : unread.has(w.id) ? h('span', 'pill new', t('status.new')) : null
  if (pill) { if (pill.matches('.run, .new')) pill.prepend(h('i')); if (pill.matches('.err')) pill.insertAdjacentHTML('afterbegin', svg('x')); el.append(pill) }
  else if (w.scriptRunning) { const r = h('span', 'pill script'); r.innerHTML = svg('play'); r.append(w.scriptRunning); r.title = t('status.script', { port: w.port }); el.append(r) }
  else el.append(h('span'))
  el.append(h('span', 'wsTitle', w.title ? w.name : t('side.newWorkspace')))
  el.onclick = () => select(w.id)
  return el
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

function renameDialog(w) {
  const f = $('#dlgForm'); f.replaceChildren()
  const input = h('input'); input.value = label(w); input.maxLength = 80
  const lab = h('label', null, t('dialog.name')); lab.append(input)
  const row = h('div', 'row')
  // type=button: Enter in the field submits with OK, not with the first button.
  const cancel = h('button', 'ghost', t('dialog.cancel')); cancel.type = 'button'; cancel.onclick = () => $('#dlg').close('cancel')
  const ok = h('button', null, t('dialog.ok')); ok.value = 'ok'
  row.append(h('span', 'grow'), cancel, ok)
  f.append(h('h3', null, t('dialog.rename')), lab, row)
  $('#dlg').returnValue = ''
  $('#dlg').showModal(); input.select()
  $('#dlg').onclose = guard(async () => {
    if ($('#dlg').returnValue === 'ok' && input.value.trim() !== label(w)) await api('PATCH', `/workspaces/${w.id}`, { title: input.value })
  })
}
$('#rename').innerHTML = svg('edit')
$('#rename').onclick = () => renameDialog(wsById(active))

// ---------- settings: a page in place of the workspace ----------
let settingsOpen = location.hash === '#settings'
function showSettings(on) {
  settingsOpen = on; renderSettings.key = null
  if (!on && wsById(active)) return select(active)
  history.replaceState(null, '', on ? '#settings' : location.pathname)
  renderSide(); renderHead(); renderSettings()
}
function renderSettings() {
  if (!settingsOpen) return
  const d = S.defaults ?? {}
  $('#defModel').value = d.model || ''; $('#defEffort').value = d.effort || ''; $('#defMode').value = d.permissionMode || 'auto'
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
const saveDefaults = guard(() => api('PATCH', '/defaults', { model: $('#defModel').value, effort: $('#defEffort').value, permissionMode: $('#defMode').value }))
$('#defModel').onchange = $('#defEffort').onchange = $('#defMode').onchange = saveDefaults
$('#openSettings').onclick = () => showSettings(true)
$('#closeSettings').onclick = () => showSettings(false)
addEventListener('keydown', e => { if (e.key === 'Escape' && settingsOpen && !$('#dlg').open) showSettings(false) })

// ---------- workspace ----------
function select(id) {
  active = id; unread.delete(id); settingsOpen = false
  history.replaceState(null, '', '#ws=' + id)
  renderSide(); renderHead(); renderPerms(); loadThread(); showTab(tab)
}

function renderHead() {
  const w = wsById(active)
  $('#settings').hidden = !settingsOpen
  $('#ws').hidden = settingsOpen || !ready || !w || !!w.archived
  if ($('#ws').hidden) return
  $('#wsName').textContent = label(w)
  $('#wsBranch').textContent = `${w.branch} ← ${w.base}`
  $('#wsBranch').title = w.path
  const n = lineOf(w); $('#wsBranch').dataset.n = $('#tabs').dataset.n = n; $('#ws').className = lineCls(n)
  $('#model').value = w.model || ''
  $('#mode').value = ['default', 'acceptEdits', 'plan'].includes(w.permissionMode) ? w.permissionMode : 'auto'
  $('#effort').value = w.effort || ''
  $('#busy').hidden = $('#stop').hidden = !w.busy
  $("#runPort").textContent = `http://localhost:${w.port}`; $("#runPort").href = `http://localhost:${w.port}`; $('#runPort').title = t('head.portTitle')
  document.title = (w.busy ? '● ' : '') + label(w) + ' · Aiguillage'
}

$('#model').onchange = guard(() => api('PATCH', `/workspaces/${active}`, { model: $('#model').value }))
$('#effort').onchange = guard(() => api('PATCH', `/workspaces/${active}`, { effort: $('#effort').value }))
$('#mode').onchange = guard(() => api('PATCH', `/workspaces/${active}`, { permissionMode: $('#mode').value }))
$('#stop').onclick = guard(() => api('POST', `/workspaces/${active}/interrupt`))

document.querySelector('#wsHead .actions').addEventListener('click', guard(async e => {
  const b = e.target.closest('button[data-act]'); if (!b) return
  const w = wsById(active), act = b.dataset.act
  let body = { app: b.dataset.app }
  if (act === 'archive' && !confirm(t('head.confirmArchive', { name: w.name, branch: w.branch }))) return
  if (act === 'merge' && !confirm(t('head.confirmMerge', { branch: w.branch, base: w.base }))) return
  if (act === 'commit') { const m = prompt(t('head.commitPrompt'), w.title || ''); if (m == null) return; body = { message: m } }
  b.disabled = true
  try {
    const r = await api('POST', `/workspaces/${active}/${act}`, body)
    if (r.message) toast(r.message)
    if (act === 'archive') { active = null; renderSide(); renderHead() } else if (tab === 'diff') loadDiff()
  } finally { b.disabled = false }
}))

// ---------- chat ----------
let toolEls = new Map()
const thread = $('#thread')
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
  if (!evs.length) { const p = h('div', 'hint'); p.innerHTML = t('chat.ready', { path: wsById(id)?.path ?? '', interpolation: { escapeValue: true } }); thread.append(p) }
  evs.forEach(renderEv)
  thread.scrollTop = thread.scrollHeight
}

const rel = p => { const w = wsById(active); return w && typeof p === 'string' && p.startsWith(w.path + '/') ? p.slice(w.path.length + 1) : p }
function toolSummary(name, i = {}) {
  return i.command ?? rel(i.file_path ?? i.notebook_path) ?? i.pattern ?? i.description ?? i.url ?? i.query ?? i.skill ?? Object.values(i).find(v => typeof v === 'string') ?? ''
}

function renderEv(ev) {
  if (ev.type === 'cg_user') {
    const m = h('div', 'msg me'); m.append(h('div', 'body', ev.text))
    if (ev.cp) {
      const b = ibtn('undo', t('chat.revert'), 'revert'); b.title = t('chat.revertTitle')
      b.onclick = guard(async () => {
        if (!confirm(t('chat.confirmRevert'))) return
        const r = await api('POST', `/workspaces/${active}/revert`, { msgId: ev.id })
        $('#input').value = r.text; $('#input').focus(); if (tab === 'diff') loadDiff()
      })
      m.append(b)
    }
    return thread.append(m)
  }
  if (ev.type === 'system') return thread.append(h('div', 'meta', `session ${ev.session_id.slice(0, 8)} · ${ev.model}`))
  if (ev.type === 'cg_error') return thread.append(h('div', 'msg err', ev.key ? t(ev.key, ev.vars) : ev.text))
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
      const m = h('div', 'msg ai' + (parent ? ' small' : '')); m.innerHTML = md(c.text); into.append(m)
    } else if (c.type === 'text') into.append(h('div', 'meta', c.text))
    else if (c.type === 'tool_use') into.append(toolEl(c))
    else if (c.type === 'tool_result') {
      const t = toolEls.get(c.tool_use_id); if (!t) continue
      const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map(x => x.text ?? `[${x.type}]`).join('\n')
      const out = t.querySelector('.out'); out.textContent = text.length > 8000 ? text.slice(0, 8000) + '\n…' : text
      out.hidden = !text
      if (c.is_error) t.classList.add('bad')
      t.classList.add('done')
    }
  }
}

function toolEl(c) {
  const d = h('details', 'tool')
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
  } else if (c.name !== 'Read') d.append(h('pre', null, typeof i.command === 'string' ? i.command : JSON.stringify(i, null, 2)))
  const out = h('pre', 'out'); out.hidden = true
  d.append(out, h('div', 'sub'))
  toolEls.set(c.id, d)
  return d
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
      const body = h('div', 'msg ai plan'); body.innerHTML = md(p.input.plan); card.append(body)
    } else {
      card.append(permQ(t('perm.wantsTool', { tool: p.tool })), h('pre', null, String(toolSummary(p.tool, p.input) || JSON.stringify(p.input, null, 2))))
    }
    const row = h('div', 'row')
    const no = h('button', 'ghost', t(plan ? 'perm.denyPlan' : 'perm.deny'))
    const yes = h('button', null, t(plan ? 'perm.approvePlan' : 'perm.allow'))
    no.onclick = guard(async () => {
      const message = plan ? prompt(t('perm.planFeedback')) : undefined
      if (plan && message == null) return
      await api('POST', `/workspaces/${active}/permission`, { id: p.id, allow: false, message })
    })
    yes.onclick = guard(() => api('POST', `/workspaces/${active}/permission`, { id: p.id, allow: true }))
    row.append(h('span', 'grow'), no, yes); card.append(row); box.append(card)
  }
}

$('#composer').onsubmit = guard(async e => {
  e.preventDefault()
  const text = $('#input').value.trim(); if (!text || !active) return
  if (Notification.permission === 'default') Notification.requestPermission()
  $('#input').value = ''
  try { await api('POST', `/workspaces/${active}/send`, { text }) } catch (err) { $('#input').value = text; throw err }
})
$('#input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit() } }

// ---------- right panel ----------
function showTab(t) {
  tab = t
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === t)
  $('#diffView').hidden = t !== 'diff'; $('#termView').hidden = t !== 'term'; $('#runView').hidden = t !== 'run'
  $('#refresh').hidden = t !== 'diff'
  if (!active) return
  if (t === 'diff') loadDiff()
  if (t === 'term') mountTerm(`${active}:shell`, $('#termView'))
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
  if (!files.length) return box.append(h('div', 'hint', t('panel.noChanges')))
  const sum = h('div', 'files')
  for (const f of files) {
    const name = (f.match(/^\+\+\+ b\/(.*)$/m) ?? f.match(/^--- a\/(.*)$/m) ?? f.match(/^diff --git a\/(.*?) b\//))?.[1] ?? '?'
    // Only lines after the first @@ are content: a removed "-- comment" line must not pass for a header.
    const hunks = f.includes('\n@@') ? f.slice(f.indexOf('\n@@')) : ''
    const add = (hunks.match(/^\+/gm) ?? []).length, del = (hunks.match(/^-/gm) ?? []).length
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

// ---------- keyboard ----------
addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey)) return
  const l = live()
  if (/^[1-9]$/.test(e.key) && l[e.key - 1]) { e.preventDefault(); select(l[e.key - 1].id) }
})

translateDom()
for (const o of $('#effort').options) o.textContent = o.value ? t('head.effortLevel', { level: o.value }) : t('head.effortDefault')
$('#lang').replaceChildren(...Object.entries(LANGS).map(([code, name]) => { const o = h('option', null, name); o.value = code; o.selected = code === lang(); return o }))
$('#langRow').hidden = $('#lang').options.length < 2
// New-workspace defaults offer the same choices as the header.
for (const k of ['Model', 'Effort', 'Mode']) $('#def' + k).append(...[...$('#' + k.toLowerCase()).options].map(o => o.cloneNode(true)))
$('#closeSettings').innerHTML = svg('x')
$('#openSettings').insertAdjacentHTML('afterbegin', svg('gear'))
$('#lang').onchange = async () => { await setLang($('#lang').value); location.reload() }
$('#theme').value = theme()
$('#theme').onchange = () => setTheme($('#theme').value)

// Desktop app: the window has no title bar, so the sheet makes room for the traffic lights and drags the window.
if (/Electron\//.test(navigator.userAgent)) document.documentElement.classList.add('electron')
$('#refresh').innerHTML = svg('refresh')
$('#runStart').insertAdjacentHTML('afterbegin', svg('play'))
$('#runStop').insertAdjacentHTML('afterbegin', svg('stop'))
for (const b of [$('#addRepo'), $('#emptyAdd')]) { b.textContent = t('side.addRepo'); b.classList.add('ico'); b.insertAdjacentHTML('afterbegin', svg('plus')) }

connect()
api('GET', '/state').then(s => { S = s; if (settingsOpen) showSettings(true); else { renderSide(); if (wsById(active)) select(active) } })
checkSetup()
