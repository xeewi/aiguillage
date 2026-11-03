// One long-lived `claude -p` process per workspace, spoken to in stream-json over stdio.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, sep, join, dirname, basename } from 'node:path'
import { realpathSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import readline from 'node:readline'
import { state, save, appendLog, readLog, writeLog, newId, runLogPath, attachDir } from './store.js'
import * as G from './git.js'
import { fail, notice } from './i18n.js'

const CLAUDE = () => process.env.AIGUILLAGE_CLAUDE || 'claude'
// workspace id -> { proc, busy: turns in flight, pending: Map<requestId, perm>, tasks: Map<Agent tool_use_id, subagent>, lock }
const agents = new Map()
let emit = () => {}
let changed = () => {}
export function wire(emitFn, changedFn) { emit = emitFn; changed = changedFn }

const get = id => agents.get(id) ?? agents.set(id, { proc: null, busy: 0, pending: new Map(), tasks: new Map(), stderr: '', lock: Promise.resolve(), waiters: [] }).get(id)
export const runtime = id => ({ busy: agents.get(id)?.busy > 0, failed: !!agents.get(id)?.failed, pending: [...(agents.get(id)?.pending.values() ?? [])],
  tasks: [...(agents.get(id)?.tasks.values() ?? [])] })
// A backgrounded subagent or shell outlives the turn: the process must not be recycled under it.
const live = a => a.busy > 0 || a.tasks.size > 0
// What the agent is busy with: a dev server left running in the background is not work (nor a reason to hold an update).
export const working = r => r.busy || r.tasks.some(t => !t.shell)

// Subagents and background shells the CLI reports (task_started → task_progress… → task_notification), keyed by
// their Agent / Bash tool call, whose block in the thread holds what they do. Both stop with stop_task.
export function track(tasks, ev) {
  const id = ev.tool_use_id
  if (!id) return false
  if (ev.subtype === 'task_started' && /agent|bash/.test(ev.task_type ?? '')) {
    tasks.set(id, { id, taskId: ev.task_id, description: ev.description ?? '', type: ev.subagent_type ?? '', background: !!ev.is_backgrounded, last: '',
      shell: ev.task_type.includes('bash') })
    return true
  }
  const t = tasks.get(id)
  if (!t) return false
  if (ev.subtype === 'task_progress') t.last = ev.description ?? ''
  else if (ev.subtype === 'task_notification') tasks.delete(id)
  else return false
  return true
}

export function cleanEnv() {
  const env = { ...process.env }
  // Started from inside Claude Code? Don't let the child think it's nested.
  // (CLAUDE_CODE_CHILD_SESSION would also turn transcript saving off, and --resume needs the transcript.)
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDE_CODE_CHILD_SESSION
  // Use the user's Claude login (subscription), never API-key billing: the CLI prefers these when set.
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

export function envFor(ws) {
  const repo = state.repos.find(r => r.id === ws.repoId)
  const env = cleanEnv()
  const vars = {
    ROOT_PATH: repo?.path ?? '', WORKSPACE_NAME: ws.name, WORKSPACE_ID: ws.id, WORKSPACE_PATH: ws.path,
    DEFAULT_BRANCH: ws.base, PORT: String(ws.port), IS_LOCAL: '1',
  }
  for (const [k, v] of Object.entries(vars)) env['AIGUILLAGE_' + k] = v
  return env
}

// UI modes -> CLI permission modes. "auto" approves everything itself (instead of bypassPermissions)
// so every tool call still reaches us and edits outside the worktree can be refused.
export const isAuto = m => !m || m === 'auto' || m === 'bypassPermissions'
export const cliMode = m => isAuto(m) ? 'default' : m
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
export function inside(root, p) {
  if (typeof p !== 'string') return true
  // Follow symlinks: real path of the deepest existing ancestor + the not-yet-created rest,
  // so a link inside the worktree can't point the edit somewhere else.
  let abs = resolve(root, p), probe = abs, rest = ''
  for (;;) {
    try { abs = join(realpathSync(probe), rest); break } catch {}
    const parent = dirname(probe)
    if (parent === probe) break
    rest = join(basename(probe), rest); probe = parent
  }
  let real = root
  try { real = realpathSync(root) } catch {}
  return [root, real].some(r => abs === r || abs.startsWith(r + sep))
}

// What the agent should know about where it runs (appended to Claude Code's system prompt).
export function briefing(ws) {
  const root = state.repos.find(r => r.id === ws.repoId)?.path
  return [
    'You are running inside Aiguillage, a local app that runs several Claude Code agents in parallel, each in its own git worktree.',
    `Your workspace is ${ws.path} (branch ${ws.branch}, created from ${ws.baseRef || ws.base}). Create and edit files only inside it: edits elsewhere are refused.`,
    `Other agents work at the same time in sibling worktrees; leave the main checkout (${root}) and other worktrees alone.`,
    `Ports ${ws.port}-${ws.port + 9} are reserved for this workspace ($AIGUILLAGE_PORT is the first); use them for dev servers.`,
    `Output of the user's setup/run script is written to ${runLogPath(ws.id)}; read it when asked about the running app or its errors.`,
    `The user reviews your diff against ${ws.base} in Aiguillage and merges from there.`,
  ].join('\n')
}

function record(ws, ev) { appendLog(ws.id, ev); emit({ t: 'ev', ws: ws.id, ev }) }

// Logs keep what the UI renders, not the CLI's full telemetry.
export function slim(ev) {
  if (ev.type === 'system') return { type: 'system', subtype: 'init', model: ev.model, session_id: ev.session_id }
  if (ev.type === 'result') {
    const { subtype, is_error, duration_ms, total_cost_usd, num_turns } = ev
    return { type: 'result', subtype, is_error, duration_ms, total_cost_usd, num_turns, error: is_error ? ev.result : undefined }
  }
  return { type: ev.type, uuid: ev.uuid, parent_tool_use_id: ev.parent_tool_use_id, message: { content: ev.message.content } }
}

function start(ws) {
  const a = get(ws.id)
  const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio',
    '--permission-mode', cliMode(ws.permissionMode),
    '--disallowedTools', 'AskUserQuestion', // no UI for it in -p mode: the agent asks in plain text instead
    '--append-system-prompt', briefing(ws)]
  // Attached files live outside the worktree: let the agent read them without asking.
  mkdirSync(attachDir(ws.id), { recursive: true })
  args.push('--add-dir', attachDir(ws.id))
  if (ws.model) args.push('--model', ws.model)
  if (ws.effort) args.push('--effort', ws.effort)
  if (ws.sessionId) {
    args.push('--resume', ws.sessionId)
    if (ws.resumeAt) args.push('--resume-session-at', ws.resumeAt, '--fork-session')
  }
  const proc = spawn(CLAUDE(), args, { cwd: ws.path, env: envFor(ws) })
  a.proc = proc; a.stderr = ''
  proc.stdin.on('error', () => {})
  proc.stderr.on('data', d => { a.stderr = (a.stderr + d).slice(-4000) })
  proc.on('error', e => { a.stderr += String(e) })
  proc.on('close', code => {
    if (a.proc !== proc) return
    a.proc = null; a.pending.clear(); a.tasks.clear()
    if (a.busy) {
      a.busy = 0; a.failed = true
      { const { message: text, key, vars } = notice('chat.agentExited', { code, stderr: a.stderr.trim() }); record(ws, { type: 'cg_error', text, key, vars }) }
    }
    changed()
  })
  // The slash commands this session offers (builtins, skills, plugins, project commands), for the composer.
  write(ws, { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    let ev
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type === 'control_request' && ev.request?.subtype === 'can_use_tool') {
      const p = { id: ev.request_id, tool: ev.request.tool_name, input: ev.request.input ?? {} }
      const target = p.input.file_path ?? p.input.notebook_path
      if (EDIT_TOOLS.has(p.tool) && !inside(ws.path, target))
        return reply(ws, p, false, `Aiguillage refused: ${target} is outside your worktree ${ws.path}. Only edit files inside it.`)
      if (isAuto(ws.permissionMode) && p.tool !== 'ExitPlanMode') return reply(ws, p, true)
      a.pending.set(p.id, p)
      return changed()
    }
    if (ev.type === 'control_cancel_request') { a.pending.delete(ev.request_id); return changed() }
    if (ev.type === 'stream_event') {
      const d = ev.event
      if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta' && !ev.parent_tool_use_id)
        emit({ t: 'delta', ws: ws.id, text: d.delta.text })
      return
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id !== ws.sessionId) { ws.sessionId = ev.session_id; save() }
      if (ws.initLogged === ev.session_id) return
      ws.initLogged = ev.session_id
    } else if (ev.type === 'assistant' || ev.type === 'user') {
      if (!ev.parent_tool_use_id) ws.lastUuid = ev.uuid
    } else if (ev.type === 'system' && ev.subtype?.startsWith('task_')) {
      if (!track(a.tasks, ev)) return
      changed()
      if (ev.subtype !== 'task_notification') return
      // Logged so the subagent's block shows how it ended, even after a reload.
      return record(ws, { type: 'task', tool_use_id: ev.tool_use_id, status: ev.status })
    } else if (ev.type === 'result') {
      // A foreground subagent can't outlive its turn: never leave one listed as running.
      for (const [id, t] of a.tasks) if (!t.background) a.tasks.delete(id)
      a.busy = Math.max(0, a.busy - 1); ws.resumeAt = null
      if (ev.local_command && a.setting?.key === ev.local_command) {
        // "Set model to…", "Effort level set to auto…"; refusals read "Model 'x' not found", "Invalid argument…".
        if (!ev.is_error && /\bset\b/i.test(ev.result ?? '')) ws[a.setting.key] = a.setting.value
        a.setting = null
      }
      a.failed = !!ev.is_error && !a.interrupted; a.interrupted = false // a stop you asked for isn't a failure
      save(); changed(); refreshUsage()
      // The context fill /context shows: the idle process answers at once, without calling a model.
      write(ws, { type: 'control_request', request_id: 'ctx', request: { subtype: 'get_context_usage' } })
    } else if (ev.type === 'control_response' && ev.response?.request_id === 'ctx') {
      if (ev.response.subtype === 'success') { ws.context = parseContext(ev.response.response); save(); changed() }
      return
    } else if (ev.type === 'control_response' && ev.response?.request_id === 'init') {
      a.commands = slashCommands(ev.response.response)
      for (const r of a.waiters.splice(0)) r(a.commands)
      return
    } else if (ev.type === 'conversation_reset') {
      // /clear: the CLI starts a new session (its init follows). The next message opens it, nothing to resume at.
      ws.lastUuid = null
      return record(ws, { type: 'cg_clear', ts: Date.now() })
    } else return // hooks, rate limits, control acks…
    record(ws, slim(ev))
  })
}

const write = (ws, obj) => get(ws.id).proc?.stdin.write(JSON.stringify(obj) + '\n')
const control = (ws, request) => write(ws, { type: 'control_request', request_id: newId(), request })

// send and revert both touch files, log and process: never let them interleave.
const serial = (a, fn) => { const p = a.lock.then(fn); a.lock = p.catch(() => {}); return p }

// Files go to the agent as paths, like a file dragged into the Claude Code terminal: its Read tool
// opens text, code, images, PDFs and notebooks, and it can script the rest (docx, xlsx, zip…).
// ponytail: images aren't inlined as base64 blocks; an oversized one would poison the whole session.
export const withFiles = (text, files) => files.length
  ? [text, `Attached files (open them with the Read tool; for other formats, use a script):\n${files.map(f => '- ' + f.path).join('\n')}`].filter(Boolean).join('\n\n')
  : text

// files: [{ name, path, url? }] already checked by the server to be this workspace's attachments.
export function send(ws, text, files = []) {
  const a = get(ws.id)
  // A deleted worktree makes spawn() fail with a misleading "spawn claude ENOENT".
  if (!existsSync(ws.path)) return Promise.reject(fail('errors.worktreeMissing', { path: ws.path }))
  return serial(a, async () => {
  let cp = null
  try {
    if (await G.busy(ws.path)) throw fail('errors.gitBusy')
    cp = await G.snapshot(ws.path)
    await G.pin(ws.path, `refs/aiguillage/${ws.id}/${Date.now()}`, cp)
  } catch { cp = null } // empty repo, merge in progress…: no checkpoint, still chat
  record(ws, { type: 'cg_user', id: newId(), text, files: files.length ? files : undefined, cp, prevUuid: ws.lastUuid ?? null, ts: Date.now() })
  const gist = text || files.map(f => f.name).join(' ')
  if (!ws.title) { ws.title = words(gist, '…'); nameFrom(ws, gist) }
  save()
  if (!a.proc) start(ws)
  a.busy++; a.failed = false
  changed()
  write(ws, { type: 'user', message: { role: 'user', content: withFiles(text, files) } })
  a.setting = setting(text) ?? a.setting
  })
}

// /model and /effort typed in the chat switch the live session; once the CLI confirms, the workspace keeps the
// choice too, or the next restart (--model, --effort) would silently undo it. "default"/"auto" = back to the CLI's.
export function setting(text) {
  const [, key, value] = text.trim().match(/^\/(model|effort)\s+(\S+)$/) ?? []
  return key && { key, value: ['default', 'auto'].includes(value) ? '' : value }
}

// initialize answer -> what the composer suggests after « / ».
export const slashCommands = r => (r?.commands ?? []).filter(c => c?.name && !c.name.startsWith('__'))
  .map(c => ({ name: c.name, description: c.description ?? '', hint: c.argumentHint ?? '', aliases: c.aliases ?? [] }))

// Starts the idle agent if needed: it is the one asked, so the list matches this worktree (its skills, plugins).
export function commands(ws) {
  const a = get(ws.id)
  if (a.commands) return Promise.resolve(a.commands)
  if (!a.proc && existsSync(ws.path)) start(ws)
  return new Promise(r => { a.waiters.push(r); setTimeout(() => r([]), 30_000).unref() })
}

// Titles stay short in the sidebar: at most 5 words, whatever the source.
export const words = (s, more = '') => { const w = s.split(/\s+/).filter(Boolean); return w.slice(0, 5).join(' ').slice(0, 60) + (w.length > 5 ? more : '') }

// The workspace's display name: a few words Haiku draws from the first message. Best effort: the
// truncated message stays if the CLI fails, and a rename done meanwhile wins. Runs outside the
// worktree without user settings, tools or MCP, so no hooks fire and it takes ~3 s.
function nameFrom(ws, text) {
  const draft = ws.title
  const p = promisify(execFile)(CLAUDE(), ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence',
    '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project', '--system-prompt', 'You name coding tasks.'],
  { cwd: tmpdir(), env: envFor(ws), timeout: 60_000 })
  p.child.stdin.on('error', () => {})
  p.child.stdin.end(`Give this task a title of at most 5 words, in the language it is written in: the gist of what we are doing, not a quote from the message (e.g. "Fix login redirect", "Page de réglages", "Bug onglet Run"). No quotes, no punctuation. Reply with the title only.\n\n${text.slice(0, 4000)}`)
  p.then(({ stdout }) => {
    const name = words(stdout.trim().split('\n')[0].replace(/^[\s"'«“*#]+|[\s"'»”*.]+$/g, ''))
    if (name && ws.title === draft) { ws.title = name; save(); changed() }
  }, () => {})
}

// Plan limits (session, week, per model), the ones /usage shows. A throwaway `claude -p` answers the
// get_usage control request without calling a model; the CLI caches it per account for 60 s, so polling
// stays cheap. Same isolation as nameFrom: no hooks, MCP or tools. Kept until a newer answer replaces it.
let usage = null, usageAt = 0
export const usageNow = () => usage
export function refreshUsage() {
  if (Date.now() - usageAt < 60_000) return
  usageAt = Date.now()
  const p = spawn(CLAUDE(), ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project'], { cwd: tmpdir(), env: cleanEnv() })
  const timer = setTimeout(() => p.kill(), 30_000); timer.unref()
  p.on('error', () => {}); p.stdin.on('error', () => {})
  p.on('close', () => clearTimeout(timer))
  p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n')
  readline.createInterface({ input: p.stdout }).on('line', line => {
    let ev
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type !== 'control_response' || ev.response?.request_id !== 'usage') return
    p.kill()
    if (ev.response.subtype !== 'success') return
    usage = parseUsage(ev.response.response, Date.now()); changed()
  })
}
// get_context_usage answer -> what the terminal shows: with auto-compact on, the share used of the window minus
// its autocompact buffer ("X% until auto-compact" = 100 - pct); off, the share of the whole window ("X% context used").
export function parseContext(r) {
  if (!(r?.maxTokens > 0) || typeof r.totalTokens !== 'number') return null
  const buffer = r.categories?.find(c => c.id === 'autocompact_buffer')?.tokens ?? 0
  const limit = r.maxTokens - buffer
  if (limit <= 0) return null
  return { used: r.totalTokens, limit, pct: Math.min(100, Math.round(100 * r.totalTokens / limit)), auto: buffer > 0 }
}

// null = no plan limits to show (API key login, logged out).
export function parseUsage(r, at) {
  const limits = r?.rate_limits_available && r.rate_limits?.limits
  if (!Array.isArray(limits)) return null
  return { plan: r.subscription_type ?? null, at, limits: limits.filter(l => typeof l?.percent === 'number').map(l => ({
    kind: l.kind, model: l.scope?.model?.display_name ?? null, pct: l.percent, resetsAt: Date.parse(l.resets_at) || null })) }
}

// One subagent or shell, not the turn: the CLI ends it with a task_notification « stopped », then tells the main agent.
export function stopTask(ws, id) {
  const t = get(ws.id).tasks.get(id)
  if (t) control(ws, { subtype: 'stop_task', task_id: t.taskId })
}

export function interrupt(ws) {
  const a = get(ws.id)
  if (!a.proc || !a.busy) return
  a.interrupted = true
  control(ws, { subtype: 'interrupt' })
  const proc = a.proc
  setTimeout(() => { if (a.proc === proc && a.busy) stop(ws) }, 5000)
}

function reply(ws, p, allow, message) {
  const response = allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: message || 'Denied by the user.' }
  // Approving a plan leaves plan mode for auto.
  if (allow && p.tool === 'ExitPlanMode') {
    response.updatedPermissions = [{ type: 'setMode', mode: cliMode('auto'), destination: 'session' }]
    ws.permissionMode = 'auto'; save()
  }
  write(ws, { type: 'control_response', response: { subtype: 'success', request_id: p.id, response } })
}

export function answer(ws, id, allow, message) {
  const a = get(ws.id)
  const p = a.pending.get(id)
  if (!p) return
  a.pending.delete(id)
  reply(ws, p, allow, message)
  changed()
}

// Model / mode / effort changes: live when the CLI supports it, otherwise an idle process is
// restarted (with --resume) on the next message. Auto <-> Demander is decided here, no restart.
export function configure(ws, { model, permissionMode, effort }) {
  const a = get(ws.id)
  if (model !== undefined && model !== ws.model) {
    ws.model = model
    if (live(a)) control(ws, { subtype: 'set_model', model: model || 'default' }); else stop(ws)
  }
  if (effort !== undefined && effort !== ws.effort) { ws.effort = effort; if (!live(a)) stop(ws) }
  if (permissionMode && permissionMode !== ws.permissionMode) {
    const before = cliMode(ws.permissionMode)
    ws.permissionMode = permissionMode
    if (cliMode(permissionMode) !== before) {
      if (live(a)) control(ws, { subtype: 'set_permission_mode', mode: cliMode(permissionMode) }); else stop(ws)
    }
    // Switching to auto approves what was waiting.
    if (isAuto(permissionMode)) for (const p of [...a.pending.values()]) if (p.tool !== 'ExitPlanMode') answer(ws, p.id, true)
  }
  save()
}

export function stop(ws) {
  const a = agents.get(ws.id)
  if (!a?.proc) return
  // Detach right away so a message sent next spawns a fresh process instead of hitting the dying one.
  const proc = a.proc
  a.proc = null; a.busy = 0; a.pending.clear(); a.tasks.clear()
  changed()
  proc.kill('SIGTERM')
  setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL') }, 3000)
}

// Rewind files AND conversation to just before a given user message.
export function revert(ws, msgId) {
  return serial(get(ws.id), () => revertNow(ws, msgId))
}
async function revertNow(ws, msgId) {
  if (get(ws.id).busy) throw fail('errors.interruptFirst')
  const log = readLog(ws.id)
  const i = log.findIndex(e => e.type === 'cg_user' && e.id === msgId)
  if (i < 0 || !log[i].cp) throw fail('errors.noCheckpoint')
  // ponytail: the agent no longer remembers what came before a /clear, so there is no conversation to go back to.
  if (log.slice(i).some(e => e.type === 'cg_clear')) throw fail('errors.revertCleared')
  await G.restore(ws.path, log[i].cp)
  stop(ws)
  writeLog(ws.id, log.slice(0, i))
  if (log[i].prevUuid) ws.resumeAt = ws.lastUuid = log[i].prevUuid
  else ws.sessionId = ws.resumeAt = ws.lastUuid = null
  ws.context = null // rewound: the fill is known again after the next turn
  save()
  emit({ t: 'reload', ws: ws.id })
  return { text: log[i].text, files: log[i].files ?? [] }
}
