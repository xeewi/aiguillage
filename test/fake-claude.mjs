#!/usr/bin/env node
// A deterministic stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// It speaks the same stdio protocol Aiguillage uses (init/assistant/user/result events, partial deltas,
// can_use_tool permission requests, interrupt / set_model / set_permission_mode controls) and keeps
// sessions on disk so --resume, --resume-session-at and --fork-session can be checked.
//
// Messages are commands (first word):
//   write <path> <text…>   Write tool          bash <cmd…>   Bash tool
//   plan <text…>           ExitPlanMode        todo          TodoWrite (never asks)
//   slow                   streams until interrupted        memory  lists this session's user messages
//   env                    prints flags + env as JSON       crash   exits with an error
//   markdown               hostile markdown (XSS probes)    anything else: "ok: <text>"
// Env: FAKE_CLAUDE_HOME (session store dir), FAKE_CLAUDE_LOG (one JSON line of argv per launch).
import readline from 'node:readline'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
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
  interrupted = false; turns = 1
  out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [] })
  messages.push({ uuid: randomUUID(), role: 'user', text })
  const [cmd, ...rest] = text.trim().split(/\s+/)
  const arg = text.trim().slice(cmd.length).trim()
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
        AIGUILLAGE_PORT: process.env.AIGUILLAGE_PORT,
        AIGUILLAGE_WORKSPACE_NAME: process.env.AIGUILLAGE_WORKSPACE_NAME, CLAUDECODE: process.env.CLAUDECODE ?? null,
      }))
      break
    case 'crash':
      process.stderr.write('boom: simulated crash\n')
      process.exit(3)
    case 'markdown':
      say('**bold** <img src="x" onerror="window.__xss=1"> <script>window.__xss=2</script> [click](javascript:window.__xss=3)\n\n```js\nconst a = 1\n```')
      break
    default:
      say(`ok: ${text}`)
  }
  save()
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, total_cost_usd: 0.01, num_turns: turns, session_id: sid, uuid: randomUUID() })
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
  try { m = JSON.parse(line) } catch { return }
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
    if (q.subtype === 'set_model') model = q.model
    if (q.subtype === 'set_permission_mode') mode = q.mode
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
  }
}).on('close', () => { closed = true; if (!running) process.exit(0) })
