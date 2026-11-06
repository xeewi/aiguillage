#!/usr/bin/env node
// A deterministic stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// It speaks the same stdio protocol Aiguillage uses (init/assistant/user/result events, partial deltas,
// can_use_tool permission requests, interrupt / set_model / set_permission_mode controls) and keeps
// sessions on disk so --resume, --resume-session-at and --fork-session can be checked.
//
// Messages are commands (first word):
//   write <path> <text…>   Write tool          bash <cmd…>   Bash tool
//   plan <text…>           ExitPlanMode        todo          TodoWrite (never asks)
//   slow                   streams until interrupted (the turn then ends is_error, as the CLI's)
//   memory                 lists this session's user messages
//   env                    prints flags + env as JSON       crash   exits with an error
//   markdown               hostile markdown (XSS probes)    /clear  resets the conversation
//   anything else: "ok: <text>"
//   subagent <ms>          a background Agent that runs a Bash, works <ms> (default 800) after the turn, then reports;
//                          the stop_task control ends it early with « stopped »
//   shell <ms>             a Bash left running in the background (npm run dev), done after <ms> (default 800); stop_task too
//                          Both report back in a turn the CLI starts on its own, which takes NOTICE_MS.
//   race                   lands right behind a background task's notification: that empty turn ends first (num_turns 0),
//                          then this one works ~800 ms and says "raced"
//   report <status> <text…>  replies <text> then an aig-report block (status as given; checks: fake)
//   merge                  a tool that takes ~800 ms; messages sent meanwhile join this turn (one result for all)
//   hang <ms>              init, then not a line for <ms> (default 1000), then replies "woke" (the watchdog's silence)
//   loop                   the same Bash call (echo same) three times, then ~500 ms of thought, then "looped"
//   deaf <ms>              ignores an interrupt: works <ms> (default 10000) then says "deaf done" (Aiguillage's forced stop)
//   fail <text…>           the turn ends is_error with <text> as its error (an API error), not interrupted
//   A message from Telegram to the aiguilleur (« [Telegram] bash curl … », after the reports it reads) runs its command too.
// Env: FAKE_CLAUDE_HOME (session store dir), FAKE_CLAUDE_LOG (one JSON line of argv per launch).
//      FAKE_CLAUDE_SESSION_PCT (the usage probe's session %, default 42), FAKE_CLAUDE_USAGE_MS (its delay before answering),
//      FAKE_CLAUDE_SESSION_RESETS_H (hours until the session resets, default 2; negative: a reset time already past).
import readline from 'node:readline'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
// One-shot `claude -p` with the prompt on stdin (how Aiguillage names a workspace): answers with the
// prompt's last line, quoted, so the cleanup is exercised. "crash" fails. Not logged: FAKE_CLAUDE_LOG lists agents.
if (argv[0] === '-p' && !argv.includes('--input-format')) {
  let s = ''
  for await (const d of process.stdin) s += d
  const last = s.trim().split('\n').at(-1)
  if (last === 'crash') process.exit(3)
  process.stdout.write(`"Named: ${last}."\n`)
  process.exit(0)
}
// Usage probe (no permission tool: not an agent): answers get_usage with fixed plan limits. Not logged.
if (argv.includes('--input-format') && !argv.includes('--permission-prompt-tool')) {
  const rl = readline.createInterface({ input: process.stdin })
  for await (const line of rl) {
    const m = JSON.parse(line)
    await new Promise(r => setTimeout(r, Number(process.env.FAKE_CLAUDE_USAGE_MS) || 0))
    const resets = h => new Date(Date.now() + h * 3600_000).toISOString()
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {
      subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [
        { kind: 'session', percent: Number(process.env.FAKE_CLAUDE_SESSION_PCT) || 42, resets_at: resets(Number(process.env.FAKE_CLAUDE_SESSION_RESETS_H) || 2), scope: null },
        { kind: 'weekly_all', percent: 93, resets_at: resets(60), scope: null },
        { kind: 'weekly_scoped', percent: 12, resets_at: resets(60), scope: { model: { display_name: 'Opus' } } }] } } } }) + '\n')
  }
  process.exit(0)
}
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\n')

// First-run checks (GET /api/doctor). FAKE_CLAUDE_LOGGED_OUT=1 simulates a fresh install.
if (argv[0] === '--version') { console.log('0.0.0 (fake)'); process.exit(0) }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: !process.env.FAKE_CLAUDE_LOGGED_OUT })); process.exit(0) }

const HOME = process.env.FAKE_CLAUDE_HOME || join(tmpdir(), 'fake-claude')
mkdirSync(HOME, { recursive: true })
const file = id => join(HOME, id + '.json')

let model = flag('--model') || 'fake-model'
let mode = flag('--permission-mode') || 'default'
const resumeId = flag('--resume')
let sid = resumeId && !argv.includes('--fork-session') ? resumeId : randomUUID()
let messages = resumeId && existsSync(file(resumeId)) ? JSON.parse(readFileSync(file(resumeId), 'utf8')) : []
const at = flag('--resume-session-at')
if (at) { const i = messages.findIndex(m => m.uuid === at); if (i >= 0) messages = messages.slice(0, i + 1) }
const save = () => writeFileSync(file(sid), JSON.stringify(messages))

const out = ev => process.stdout.write(JSON.stringify(ev) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- permissions ----
const waiting = new Map() // request_id -> resolve
let interrupted = false
function ask(tool, input) {
  const request_id = randomUUID()
  out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: tool, input } })
  return new Promise(r => waiting.set(request_id, r))
}
const insideCwd = p => { const a = resolve(p); return a.startsWith(process.cwd() + sep) }
function needsAsk(tool, input) {
  if (tool === 'TodoWrite') return false
  if (mode === 'bypassPermissions') return false
  if (mode === 'acceptEdits' && tool === 'Write' && insideCwd(input.file_path)) return false
  return true
}

const background = {} // task_id -> stop(): subagents and shells still running (stop_task ends them)
const NOTICE_MS = 400
// The turn the CLI starts by itself to tell the agent a background task ended: no user message behind it.
async function notice(text) {
  out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [] })
  await sleep(NOTICE_MS)
  assistant([{ type: 'text', text }])
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: NOTICE_MS, total_cost_usd: 0, num_turns: 1, session_id: sid, uuid: randomUUID() })
}

// ---- one turn ----
let turns = 0
function assistant(content) {
  const uuid = randomUUID()
  messages.push({ uuid, role: 'assistant', text: content.map(c => c.text ?? c.name).join('') })
  out({ type: 'assistant', uuid, parent_tool_use_id: null, session_id: sid, message: { role: 'assistant', content } })
}
function say(text) {
  for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) {
    out({ type: 'stream_event', parent_tool_use_id: null, session_id: sid, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } })
  }
  assistant([{ type: 'text', text }])
}
async function tool(name, input, run) {
  const id = 'toolu_' + randomUUID().slice(0, 8)
  assistant([{ type: 'tool_use', id, name, input }])
  turns++
  const d = needsAsk(name, input) ? await ask(name, input) : { behavior: 'allow', updatedInput: input }
  let res
  if (d.behavior === 'allow') {
    for (const u of d.updatedPermissions ?? []) if (u.type === 'setMode') mode = u.mode
    try { res = { content: String(await run(d.updatedInput ?? input)) } } catch (e) { res = { content: String(e.message), is_error: true } }
  } else res = { content: d.message ?? 'denied', is_error: true }
  out({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: res.content, is_error: !!res.is_error }] } })
  return res
}

async function turn(text) {
  const t0 = Date.now()
  // Like the real CLI: a reset event, then a fresh session with no memory and an empty local-command result.
  if (text.trim() === '/clear') {
    out({ type: 'conversation_reset', trigger: 'clear', session_id: sid })
    sid = randomUUID(); messages = []; save()
    out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [] })
    return out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 0, result: '', local_command: 'clear', session_id: sid, uuid: randomUUID() })
  }
  // Local commands answer at once, with the real CLI's wording; "/model nope" fails like an unknown model.
  const local = text.trim().match(/^\/(model|effort|permissions)(?:\s+(\S+))?$/)
  if (local) {
    const [, name, arg] = local
    out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [] })
    const reply = name === 'permissions' ? '/permissions isn\'t available in this environment.'
      : arg === 'nope' ? `Model 'nope' not found` : name === 'model' ? (model = arg, `Set model to \`${arg}\` for this session only`) : arg === 'auto' ? 'Effort level set to auto (this session only)' : `Set effort level to ${arg} (this session only)`
    out({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
    return out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 0, result: reply, local_command: name === 'permissions' ? undefined : name, session_id: sid, uuid: randomUUID() })
  }
  if (text.trim() === 'race') {
    out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [] })
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 80, total_cost_usd: 0, num_turns: 0, session_id: sid, uuid: randomUUID() })
  }
  interrupted = false; turns = 1
  let failWith = null
  out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [] })
  messages.push({ uuid: randomUUID(), role: 'user', text })
  // A message from Telegram (the aiguilleur's prompt: reports, then « [Telegram] <message> ») runs the command it carries.
  const said = text.match(/(?:^|\n\n---\n\n)\[Telegram\] ([^]*)$/)?.[1] ?? text
  const [cmd, ...rest] = said.trim().split(/\s+/)
  const arg = said.trim().slice(cmd.length).trim()
  switch (cmd.toLowerCase()) {
    case 'write': {
      const [path, ...words] = rest
      const r = await tool('Write', { file_path: path, content: words.join(' ') + '\n' }, i => {
        mkdirSync(dirname(resolve(i.file_path)), { recursive: true }); writeFileSync(i.file_path, i.content); return `File created successfully at: ${i.file_path}`
      })
      say(r.is_error ? `write failed: ${r.content}` : `wrote ${path}`)
      break
    }
    case 'bash': {
      const r = await tool('Bash', { command: arg, description: 'fake' }, i => execSync(i.command, { encoding: 'utf8' }) || '(no output)')
      say(r.is_error ? `bash failed: ${r.content}` : `bash ok: ${r.content.trim()}`)
      break
    }
    case 'plan': {
      const r = await tool('ExitPlanMode', { plan: `## Plan\n\n${arg}` }, () => 'User has approved your plan.')
      say(r.is_error ? `plan rejected: ${r.content}` : `plan approved, mode now ${mode}`)
      break
    }
    case 'todo':
      await tool('TodoWrite', { todos: [{ content: 'first step', status: 'completed' }, { content: 'second step', status: 'in_progress' }, { content: 'third step', status: 'pending' }] }, () => 'ok')
      say('todos updated')
      break
    case 'slow': {
      let text = ''
      for (let i = 0; i < 100 && !interrupted; i++) {
        const chunk = `tick ${i} `
        text += chunk
        out({ type: 'stream_event', parent_tool_use_id: null, session_id: sid, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } })
        await sleep(100)
      }
      assistant([{ type: 'text', text }])
      if (interrupted) out({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
      break
    }
    case 'memory':
      say('memory: ' + messages.filter(m => m.role === 'user').map(m => m.text).join(' | '))
      break
    case 'env':
      say('env: ' + JSON.stringify({
        mode, model, effort: flag('--effort') ?? null, disallowed: flag('--disallowedTools') ?? null,
        prompt: flag('--append-system-prompt') ?? '', cwd: process.cwd(),
        AIGUILLAGE_PORT: process.env.AIGUILLAGE_PORT, AIGUILLAGE_TOKEN: process.env.AIGUILLAGE_TOKEN,
        AIGUILLAGE_WORKSPACE_NAME: process.env.AIGUILLAGE_WORKSPACE_NAME, CLAUDECODE: process.env.CLAUDECODE ?? null,
      }))
      break
    case 'crash':
      process.stderr.write('boom: simulated crash\n')
      process.exit(3)
    case 'subagent': {
      // Same sequence as the real CLI: task_started, the Agent call answered at once, the subagent's own
      // messages tagged with parent_tool_use_id, task_progress, then task_notification and a turn of its own.
      const id = 'toolu_' + randomUUID().slice(0, 8), task_id = 'a' + randomUUID().slice(0, 8)
      const sub = (type, content) => out({ type, uuid: randomUUID(), parent_tool_use_id: id, session_id: sid, message: { role: type, content } })
      assistant([{ type: 'tool_use', id, name: 'Agent', input: { description: 'Look around', prompt: 'ls', subagent_type: 'general-purpose', run_in_background: true } }])
      out({ type: 'system', subtype: 'task_started', task_id, tool_use_id: id, description: 'Look around', task_type: 'local_agent', subagent_type: 'general-purpose', is_backgrounded: true, session_id: sid })
      out({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.' }] } })
      sub('assistant', [{ type: 'tool_use', id: 'toolu_sub1', name: 'Bash', input: { command: 'ls', description: 'List files' } }])
      out({ type: 'system', subtype: 'task_progress', task_id, tool_use_id: id, description: 'Running List files', last_tool_name: 'Bash', session_id: sid })
      sub('user', [{ type: 'tool_result', tool_use_id: 'toolu_sub1', content: 'README.md' }])
      const end = status => {
        delete background[task_id]
        if (status === 'completed') sub('assistant', [{ type: 'text', text: 'subagent done' }])
        out({ type: 'system', subtype: 'task_notification', task_id, tool_use_id: id, status, summary: 'subagent ' + status, session_id: sid })
        notice('the subagent ' + status)
      }
      const timer = setTimeout(() => end('completed'), Number(rest[0]) || 800)
      background[task_id] = () => { clearTimeout(timer); end('stopped') }
      say('subagent launched')
      break
    }
    case 'shell': {
      // As the real CLI does it: task_started (local_bash), the Bash call answered at once, later task_notification
      // and a turn of its own. No task_progress for shells.
      const id = 'toolu_' + randomUUID().slice(0, 8), task_id = 'b' + randomUUID().slice(0, 8)
      assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true } }])
      out({ type: 'system', subtype: 'task_started', task_id, tool_use_id: id, description: 'Start the dev server', task_type: 'local_bash', is_backgrounded: true, session_id: sid })
      out({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task_id}.` }] } })
      const end = status => {
        delete background[task_id]
        out({ type: 'system', subtype: 'task_notification', task_id, tool_use_id: id, status, summary: 'shell ' + status, session_id: sid })
        notice('the shell ' + status)
      }
      const timer = setTimeout(() => end('completed'), Number(rest[0]) || 800)
      background[task_id] = () => { clearTimeout(timer); end('stopped') }
      say('shell launched')
      break
    }
    case 'race':
      await sleep(800)
      say('raced')
      break
    case 'merge': {
      await tool('Bash', { command: 'sleep 1', description: 'fake' }, () => sleep(800).then(() => '(no output)'))
      const joined = queue.splice(0)
      for (const t of joined) messages.push({ uuid: randomUUID(), role: 'user', text: t })
      say('merged: ' + joined.join(' | '))
      break
    }
    case 'hang':
      await sleep(Number(rest[0]) || 1000)
      say('woke')
      break
    case 'loop':
      for (let i = 0; i < 3; i++) await tool('Bash', { command: 'echo same', description: 'fake' }, i => execSync(i.command, { encoding: 'utf8' }))
      await sleep(500) // still in the turn when the watchdog looks
      say('looped')
      break
    case 'report': {
      const [status, ...words] = rest
      say(`${words.join(' ')}\n\n\`\`\`aig-report\nstatus: ${status}\nchecks: fake\nunverified: none\nneeds: none\n\`\`\``)
      break
    }
    case 'deaf':
      await sleep(Number(rest[0]) || 10_000)
      say('deaf done')
      break
    case 'fail':
      failWith = arg || 'boom'
      break
    case 'markdown':
      say('**bold** <img src="x" onerror="window.__xss=1"> <script>window.__xss=2</script> [click](javascript:window.__xss=3)\n\n```js\nconst a = 1\n```')
      break
    default:
      say(`ok: ${text}`)
  }
  save()
  // Like the real CLI, a turn you interrupted ends as an error.
  out({ type: 'result', subtype: interrupted || failWith ? 'error_during_execution' : 'success', is_error: interrupted || !!failWith, ...failWith && { result: failWith }, duration_ms: Date.now() - t0, total_cost_usd: 0.01, num_turns: turns, session_id: sid, uuid: randomUUID() })
}

// ---- stdin: user messages queue up, controls are handled immediately ----
const queue = []
let running = false
let closed = false
async function drain() {
  if (running) return
  running = true
  while (queue.length) await turn(queue.shift())
  running = false
  if (closed) process.exit(0)
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m
  // Run interactively (the Terminal tab's Claude Code), it is typed to: "/exit" quits.
  try { m = JSON.parse(line) } catch { if (line.trim() === '/exit') process.exit(0); return }
  if (m.type === 'user') {
    const c = m.message.content
    queue.push(typeof c === 'string' ? c : c.map(x => x.text ?? '').join(''))
    drain()
  } else if (m.type === 'control_response') {
    const r = waiting.get(m.response.request_id)
    if (r) { waiting.delete(m.response.request_id); r(m.response.response) }
  } else if (m.type === 'control_request') {
    const q = m.request
    if (q.subtype === 'interrupt') {
      interrupted = true
      for (const [id, r] of waiting) { waiting.delete(id); r({ behavior: 'deny', message: 'interrupted' }) }
    }
    if (q.subtype === 'stop_task') background[q.task_id]?.()
    if (q.subtype === 'set_model') model = q.model
    if (q.subtype === 'set_permission_mode') mode = q.mode
    // Context fill: 16 000 tokens per stored message; auto-compact at 200 000 - 40 000, so 10 % of it each.
    const ctx = q.subtype === 'get_context_usage' && { totalTokens: 16_000 * messages.length, maxTokens: 200_000, percentage: 8 * messages.length,
      categories: [{ id: 'messages', tokens: 16_000 * messages.length, kind: 'used' }, { id: 'autocompact_buffer', tokens: 40_000, kind: 'buffer' }] }
    const init = q.subtype === 'initialize' && { commands: [
      { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '', builtin: true },
      { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional custom summarization instructions>', builtin: true },
      { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
      { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>', builtin: true },
      { name: 'code-review', description: 'Review the current diff', argumentHint: '[low|high]', aliases: ['review'], builtin: true },
      { name: '__internal', description: 'hidden', argumentHint: '', builtin: true }] }
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: ctx || init || {} } })
  }
}).on('close', () => { closed = true; if (!running) process.exit(0) })
