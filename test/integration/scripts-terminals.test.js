import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, setup, makeRepo, waitFor, socket, sleep } from '../helpers.mjs'

let srv
// bash, not the user's zsh: a dotfile-less HOME would trigger zsh's interactive first-run wizard.
before(async () => { srv = await startServer({ env: { SHELL: '/bin/bash' } }) })
after(() => srv.stop())

const runLog = id => { const p = join(srv.home, 'logs', id + '.run.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
const waitLog = (id, re) => waitFor(() => re.test(runLog(id)), { what: `run log ${re}` })
const running = async id => (await srv.ws(id)).scriptRunning
const toml = (runMode, extra = '') => `[scripts]
run_mode = "${runMode}"

[scripts.run.web]
command = "echo web-started; sleep 30"
default = true

[scripts.run.hello]
command = "echo hello-from-$AIGUILLAGE_WORKSPACE_NAME"

${extra}`

test('scripts: named TOML scripts listed with their default', async () => {
  const { w } = await setup(srv, { '.aiguillage/settings.toml': toml('concurrent') })
  const s = await srv.api('GET', `/workspaces/${w.id}/scripts`)
  assert.deepEqual(Object.keys(s.run).sort(), ['hello', 'web'])
  assert.equal(s.default, 'web')
  assert.equal(s.run.hello.command, 'echo hello-from-$AIGUILLAGE_WORKSPACE_NAME')
})

test('run: the chosen script runs (run log + WS term:data), state shows it, unknown id → default, stop kills it', async () => {
  const { w } = await setup(srv, { '.aiguillage/settings.toml': toml('concurrent') })
  const s = socket(srv.base); await s.open
  await srv.api('POST', `/workspaces/${w.id}/run`, { id: 'hello' })
  await waitLog(w.id, new RegExp(`hello-from-${w.name}[\\s\\S]*\\[exit 0\\]`))
  await waitFor(() => s.msgs.some(m => m.t === 'term:data' && m.key === `${w.id}:script` && m.data.includes(`hello-from-${w.name}`)), { what: 'term:data' })

  await srv.api('POST', `/workspaces/${w.id}/run`, { id: 'does-not-exist' })
  await waitLog(w.id, /web-started/)
  assert.equal(await waitFor(() => running(w.id), { what: 'scriptRunning' }), 'web')

  await srv.api('POST', `/workspaces/${w.id}/run-stop`)
  await waitFor(async () => (await running(w.id)) === null, { what: 'script stopped' })
  assert.match(runLog(w.id), /\[exit/)
  s.close()
})

test('run: no scripts configured → 400 with a helpful message', async () => {
  const { w } = await setup(srv)
  await assert.rejects(srv.api('POST', `/workspaces/${w.id}/run`, {}), e => e.status === 400 && /settings\.toml/.test(e.message))
})

test('run: nonconcurrent stops the other workspace of the same repo; concurrent does not', async () => {
  for (const [mode, othersSurvive] of [['nonconcurrent', false], ['concurrent', true]]) {
    const repoPath = makeRepo({ '.aiguillage/settings.toml': toml(mode) })
    const repo = await srv.api('POST', '/repos', { path: repoPath })
    const a = await srv.api('POST', '/workspaces', { repoId: repo.id })
    const b = await srv.api('POST', '/workspaces', { repoId: repo.id })
    await srv.api('POST', `/workspaces/${a.id}/run`, { id: 'web' })
    await waitFor(() => running(a.id), { what: 'a running' })
    await srv.api('POST', `/workspaces/${b.id}/run`, { id: 'web' })
    await waitFor(() => running(b.id), { what: 'b running' })
    if (othersSurvive) { await sleep(300); assert.equal(await running(a.id), 'web', mode) }
    else await waitFor(async () => (await running(a.id)) === null, { what: `${mode}: a stopped` })
    for (const x of [a, b]) await srv.api('POST', `/workspaces/${x.id}/run-stop`)
  }
})

test('run: AIGUILLAGE_* variables are visible to scripts', async () => {
  const cmd = 'echo P=$AIGUILLAGE_PORT N=$AIGUILLAGE_WORKSPACE_NAME R=$AIGUILLAGE_ROOT_PATH B=$AIGUILLAGE_DEFAULT_BRANCH L=$AIGUILLAGE_IS_LOCAL I=$AIGUILLAGE_WORKSPACE_ID W=$AIGUILLAGE_WORKSPACE_PATH'
  const { repoPath, w } = await setup(srv, { 'aiguillage.json': JSON.stringify({ run: cmd }) })
  await srv.api('POST', `/workspaces/${w.id}/run`, {})
  await waitLog(w.id, /\[exit 0\]/)
  const line = runLog(w.id).split('\n').find(l => l.startsWith('P='))
  assert.equal(line, `P=${w.port} N=${w.name} R=${repoPath} B=main L=1 I=${w.id} W=${w.path}`)
})

test('run log: ANSI escape codes are stripped', async () => {
  const cmd = `printf '\\033[31mred\\033[0m \\033[1mbold\\033[0m done\\n'`
  const { w } = await setup(srv, { 'aiguillage.json': JSON.stringify({ run: cmd }) })
  await srv.api('POST', `/workspaces/${w.id}/run`, {})
  await waitLog(w.id, /\[exit 0\]/)
  assert.match(runLog(w.id), /^red bold done$/m)
  assert.doesNotMatch(runLog(w.id), /\x1b/)
})

test('terminal: term:open spawns a shell in the worktree; input, resize and output over WS', async () => {
  const { w } = await setup(srv)
  const s = socket(srv.base); await s.open
  const key = `${w.id}:shell`
  s.send({ t: 'term:open', key })
  await waitFor(() => s.msgs.some(m => m.t === 'term:reset' && m.key === key), { what: 'term:reset' })
  s.send({ t: 'term:resize', key, cols: 120, rows: 40 })
  s.send({ t: 'term:resize', key, cols: -1, rows: 'x' }) // ignored, must not crash
  s.send({ t: 'term:in', key, data: 'pwd; echo cols=$COLUMNS; echo port=$AIGUILLAGE_PORT\r' })
  const out = () => s.msgs.filter(m => m.t === 'term:data' && m.key === key).map(m => m.data).join('')
  await waitFor(() => out().includes(w.path) && out().includes(`port=${w.port}`), { what: 'shell output' })
  assert.match(out(), /cols=120/)

  // Re-opening returns the existing buffer, no second shell.
  s.msgs.length = 0
  s.send({ t: 'term:open', key })
  await waitFor(() => s.msgs.find(m => m.t === 'term:reset' && m.key === key)?.data.includes(w.path), { what: 'buffer replay' })
  assert.equal((await srv.state()).workspaces.length > 0, true, 'server still alive')
  s.close()
})

test('terminal: term:open for an archived workspace is ignored', async () => {
  const { w } = await setup(srv)
  await srv.api('POST', `/workspaces/${w.id}/archive`)
  const s = socket(srv.base); await s.open
  s.send({ t: 'term:open', key: `${w.id}:shell` })
  s.send({ t: 'term:open', key: 'nonexistent:shell' })
  await sleep(400)
  assert.ok(!s.msgs.some(m => m.t?.startsWith('term:')))
  s.close()
})
