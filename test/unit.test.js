// Unit tests for the pure parts of lib/agent.js and lib/store.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, mkdirSync, appendFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// store.js reads AIGUILLAGE_HOME at import time: point it at a throwaway dir first.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cgunit-')))
process.env.AIGUILLAGE_HOME = HOME
const store = await import('../lib/store.js')
const A = await import('../lib/agent.js')

test('permission modes: auto (and legacy bypass) run the CLI in default mode', () => {
  for (const m of [undefined, '', 'auto', 'bypassPermissions']) {
    assert.equal(A.isAuto(m), true, String(m))
    assert.equal(A.cliMode(m), 'default')
  }
  for (const m of ['default', 'acceptEdits', 'plan']) {
    assert.equal(A.isAuto(m), false)
    assert.equal(A.cliMode(m), m)
  }
})

test('inside(): worktree sandbox path check', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cgsb-')))
  assert.ok(A.inside(root, join(root, 'a.txt')))
  assert.ok(A.inside(root, join(root, 'deep/dir/b.txt')))
  assert.ok(A.inside(root, 'relative/c.txt'), 'relative paths resolve against the worktree')
  assert.ok(A.inside(root, root))
  assert.ok(A.inside(root, undefined), 'tools without a path are not path-checked')
  assert.ok(!A.inside(root, '/etc/passwd'))
  assert.ok(!A.inside(root, join(root, '../escape.txt')))
  assert.ok(!A.inside(root, root + '-sibling/x'), 'a sibling with the same prefix is outside')
  // The worktree reached through a symlink (/tmp vs /private/tmp on macOS) is still inside.
  const link = join(mkdtempSync(join(tmpdir(), 'cgln-')), 'wt')
  symlinkSync(root, link)
  assert.ok(A.inside(link, join(root, 'x')))
  assert.ok(A.inside(link, join(link, 'x')))
  // A symlink inside the worktree pointing outside must not open a way out.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cgout-')))
  symlinkSync(outside, join(root, 'escape'))
  assert.ok(!A.inside(root, join(root, 'escape/new-file.txt')))
  assert.ok(!A.inside(root, 'escape/deep/new.txt'))
  symlinkSync('/etc/hosts', join(root, 'hosts-link'))
  assert.ok(!A.inside(root, 'hosts-link'), 'a symlinked file pointing outside is outside')
})

test('slim(): logs keep what the UI renders', () => {
  assert.deepEqual(A.slim({ type: 'system', subtype: 'init', model: 'm', session_id: 's', tools: ['x'], cwd: '/' }),
    { type: 'system', subtype: 'init', model: 'm', session_id: 's' })
  const r = A.slim({ type: 'result', subtype: 'success', is_error: true, result: 'boom', duration_ms: 5, total_cost_usd: 0.1, num_turns: 2, usage: {} })
  assert.deepEqual(r, { type: 'result', subtype: 'success', is_error: true, duration_ms: 5, total_cost_usd: 0.1, num_turns: 2, error: 'boom' })
  assert.equal(A.slim({ type: 'result', is_error: false, result: 'text' }).error, undefined)
  const m = A.slim({ type: 'assistant', uuid: 'u', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: 'hi' }], usage: {} } })
  assert.deepEqual(m, { type: 'assistant', uuid: 'u', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hi' }] } })
})

test('trim(): no thinking, tool output as text, images as [image], cut at 8000', () => {
  const out = A.trim([{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'hi' },
    { type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'shot:' }, { type: 'image', source: { data: 'A'.repeat(1e6) } }] },
    { type: 'tool_result', tool_use_id: 'u', content: 'y'.repeat(9000) }])
  assert.deepEqual(out.slice(0, 2), [{ type: 'text', text: 'hi' }, { type: 'tool_result', tool_use_id: 't', is_error: true, content: 'shot:\n[image]' }])
  assert.equal(out[2].content, 'y'.repeat(8000) + '\n…')
  assert.equal(A.trim('plain'), 'plain')
})

test('track(): subagents and background shells listed from task_started to task_notification', () => {
  const tasks = new Map()
  assert.ok(!A.track(tasks, { subtype: 'task_started', tool_use_id: 'w1', task_type: 'local_workflow', description: 'review' }))
  assert.ok(A.track(tasks, { subtype: 'task_started', tool_use_id: 'b1', task_id: 'bx', task_type: 'local_bash', description: 'npm run dev', is_backgrounded: true }))
  assert.ok(A.track(tasks, { subtype: 'task_started', tool_use_id: 't1', task_type: 'local_agent', description: 'Look', subagent_type: 'Explore', is_backgrounded: true }))
  assert.ok(A.track(tasks, { subtype: 'task_progress', tool_use_id: 't1', description: 'Running ls' }))
  assert.deepEqual([...tasks.values()], [
    { id: 'b1', taskId: 'bx', description: 'npm run dev', type: '', background: true, last: '', shell: true },
    { id: 't1', taskId: undefined, description: 'Look', type: 'Explore', background: true, last: 'Running ls', shell: false }])
  assert.ok(!A.track(tasks, { subtype: 'task_updated', tool_use_id: 't1' }))
  assert.ok(!A.working({ busy: false, tasks: [tasks.get('b1')] }), 'a shell alone is not work')
  assert.ok(A.working({ busy: false, tasks: [...tasks.values()] }))
  assert.ok(A.track(tasks, { subtype: 'task_notification', tool_use_id: 'b1', status: 'completed' }))
  assert.ok(A.track(tasks, { subtype: 'task_notification', tool_use_id: 't1', status: 'completed' }))
  assert.equal(tasks.size, 0)
})

test('briefing(): tells the agent its worktree, ports, run log and base', () => {
  store.state.repos.push({ id: 'r1', path: '/repo/main', name: 'main', base: 'main' })
  const ws = { id: 'w1', repoId: 'r1', name: 'oslo', branch: 'aig/oslo', base: 'main', baseRef: 'origin/main', path: '/wt/oslo', port: 40010 }
  const b = A.briefing(ws)
  assert.match(b, /\/wt\/oslo/)
  assert.match(b, /aig\/oslo/)
  assert.match(b, /origin\/main/)
  assert.match(b, /40010-40019/)
  assert.match(b, /\/repo\/main/)
  assert.ok(b.includes(store.runLogPath('w1')))
  store.state.repos.pop()
})

test('envFor(): AIGUILLAGE_* vars, nested-session vars removed', () => {
  store.state.repos.push({ id: 'r2', path: '/repo/x' })
  process.env.CLAUDECODE = '1'; process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  const env = A.envFor({ id: 'w2', repoId: 'r2', name: 'lima', path: '/wt/lima', base: 'dev', port: 40020 })
  { const p = 'AIGUILLAGE_'
    assert.equal(env[p + 'ROOT_PATH'], '/repo/x')
    assert.equal(env[p + 'WORKSPACE_NAME'], 'lima')
    assert.equal(env[p + 'WORKSPACE_ID'], 'w2')
    assert.equal(env[p + 'WORKSPACE_PATH'], '/wt/lima')
    assert.equal(env[p + 'DEFAULT_BRANCH'], 'dev')
    assert.equal(env[p + 'PORT'], '40020')
    assert.equal(env[p + 'IS_LOCAL'], '1')
  }
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
  delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_ENTRYPOINT
  store.state.repos.pop()
})

test('store: state saved atomically, logs append/rewrite, corrupt lines skipped', () => {
  store.state.workspaces.push({ id: 'zz' })
  store.save()
  assert.ok(JSON.parse(readFileSync(join(HOME, 'state.json'), 'utf8')).workspaces.some(w => w.id === 'zz'))
  assert.ok(!existsSync(join(HOME, 'state.json.tmp')))
  store.state.workspaces.pop()

  assert.deepEqual(store.readLog('nolog'), [])
  store.appendLog('l1', { a: 1 })
  store.appendLog('l1', { b: 2 })
  appendFileSync(join(HOME, 'logs', 'l1.jsonl'), '{"half-written')
  assert.deepEqual(store.readLog('l1'), [{ a: 1 }, { b: 2 }])
  store.writeLog('l1', [{ c: 3 }])
  assert.deepEqual(store.readLog('l1'), [{ c: 3 }])
  assert.match(store.newId(), /^[a-z0-9]{6,}$/)
  assert.notEqual(store.newId(), store.newId())
})

test('store: state.json is reloaded from disk on start', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cgreload-'))
  mkdirSync(home, { recursive: true })
  const { execFileSync } = await import('node:child_process')
  const code = `const s = await import(${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)}); s.state.repos.push({id:'keep'}); s.save()`
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, AIGUILLAGE_HOME: home } })
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const s = await import(${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)}); console.log(s.state.repos[0].id)`], { env: { ...process.env, AIGUILLAGE_HOME: home }, encoding: 'utf8' })
  assert.equal(out.trim(), 'keep')
})

test('parseContext(): counts toward auto-compact like the terminal, the whole window when it is off; null when unusable', () => {
  const buffer = { id: 'autocompact_buffer', tokens: 40_000, kind: 'buffer' }
  assert.deepEqual(A.parseContext({ totalTokens: 52_000, maxTokens: 200_000, percentage: 26, categories: [{ id: 'messages', tokens: 50_000 }, buffer] }),
    { used: 52_000, limit: 160_000, pct: 33, auto: true })
  assert.deepEqual(A.parseContext({ totalTokens: 52_000, maxTokens: 200_000, categories: [{ id: 'compact_buffer', tokens: 3_000 }] }),
    { used: 52_000, limit: 200_000, pct: 26, auto: false })
  assert.equal(A.parseContext({ totalTokens: 999_999, maxTokens: 200_000, categories: [buffer] }).pct, 100)
  assert.equal(A.parseContext({ totalTokens: 1, maxTokens: 0, percentage: 0 }), null)
  assert.equal(A.parseContext(undefined), null)
})

test('parseUsage(): keeps the plan limits /usage shows, null when there are none', () => {
  const r = { subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [
    { kind: 'session', percent: 38, resets_at: '2026-11-01T20:09:59.5+00:00', scope: null },
    { kind: 'weekly_scoped', percent: 2, resets_at: null, scope: { model: { display_name: 'Fable' } } },
    { kind: 'broken' }] } }
  assert.deepEqual(A.parseUsage(r, 5), { plan: 'max', at: 5, limits: [
    { kind: 'session', model: null, pct: 38, resetsAt: Date.parse('2026-11-01T20:09:59.5Z') },
    { kind: 'weekly_scoped', model: 'Fable', pct: 2, resetsAt: null }] })
  assert.equal(A.parseUsage({ rate_limits_available: false, rate_limits: { limits: [] } }, 5), null)
  assert.equal(A.parseUsage(undefined, 5), null)
})
