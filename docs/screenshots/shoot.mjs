// Regenerates the README screenshots: `node docs/screenshots/shoot.mjs`.
// An isolated server drives the tests' fake claude (test/fake-claude.mjs); the conversations shown are then
// rewritten in the workspace logs to read like real ones. Nothing touches ~/.aiguillage.
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, git, tmp, waitFor, sleep } from '../../test/helpers.mjs'

const OUT = dirname(fileURLToPath(import.meta.url))
const MODEL = 'claude-opus-5-5'

function repo(name, files) {
  const dir = join(tmp('aigshot-'), name)
  git(dirname(dir), 'init', '-q', '-b', 'main', dir)
  git(dir, 'config', 'user.email', 'dev@example.com'); git(dir, 'config', 'user.name', 'dev')
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c) }
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init')
  return dir
}

const cart = `export const DISCOUNT = 0.1

export function total(items) {
  const sum = items.reduce((s, i) => s + i.price * i.qty, 0)
  return sum
}
`
const shop = repo('shop', {
  'package.json': JSON.stringify({ name: 'shop', type: 'module', scripts: { dev: 'node dev.mjs', test: 'node --test' } }, null, 2) + '\n',
  'dev.mjs': `import http from 'node:http'
const port = process.env.PORT || 3000
http.createServer((req, res) => { console.log(\`  \${req.method} \${req.url}\`); res.end('shop') }).listen(port, () => {
  console.log(\`\\n  \\x1b[32m\\x1b[1mshop\\x1b[0m dev server  \\x1b[2mready in 84 ms\\x1b[0m\\n\\n  \\x1b[32m➜\\x1b[0m  \\x1b[1mLocal:\\x1b[0m   \\x1b[36mhttp://localhost:\${port}/\\x1b[0m\\n\`)
})
`,
  'src/cart.js': cart,
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#f59e0b"/><path d="M9 11h14l-2 9H11z" fill="#fff"/><circle cx="13" cy="24" r="2" fill="#fff"/><circle cx="20" cy="24" r="2" fill="#fff"/></svg>\n',
})
const api = repo('api', { 'README.md': '# api\n', 'src/routes.js': 'export const routes = {}\n' })

const srv = await startServer()
const logPath = id => join(srv.home, 'logs', id + '.jsonl')
const readLog = id => readFileSync(logPath(id), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const writeLog = (id, evs) => writeFileSync(logPath(id), evs.map(e => JSON.stringify(e) + '\n').join(''))
// The fake names a workspace from its first message: wait for that, then give it a real title.
async function title(w, text) {
  await waitFor(async () => (await srv.ws(w.id)).title?.startsWith('Named'), { what: 'naming' })
  await srv.api('PATCH', `/workspaces/${w.id}`, { title: text })
}
const make = (repoId, name) => srv.api('POST', '/workspaces', { repoId, name })

const shopRepo = await srv.api('POST', '/repos', { path: shop })
const apiRepo = await srv.api('POST', '/repos', { path: api })
const tokyo = await make(shopRepo.id, 'tokyo'), lima = await make(shopRepo.id, 'lima'), oslo = await make(shopRepo.id, 'oslo')
const kyoto = await make(apiRepo.id, 'kyoto')

// ---- tokyo: a finished task, real changes in the worktree, the conversation rewritten ----
await srv.turn(tokyo.id, 'hello') // sets the session and the context meter
await title(tokyo, 'Cart discount from 3 items')
writeFileSync(join(tokyo.path, 'src/cart.js'), `export const DISCOUNT = 0.1
export const DISCOUNT_FROM = 3

export function total(items) {
  const sum = items.reduce((s, i) => s + i.price * i.qty, 0)
  const count = items.reduce((n, i) => n + i.qty, 0)
  const off = count >= DISCOUNT_FROM ? sum * DISCOUNT : 0
  return Math.round((sum - off) * 100) / 100
}
`)
mkdirSync(join(tokyo.path, 'test'), { recursive: true })
writeFileSync(join(tokyo.path, 'test/cart.test.js'), `import test from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/cart.js'

test('no discount under 3 items', () => {
  assert.equal(total([{ price: 10, qty: 2 }]), 20)
})

test('10% off from 3 items', () => {
  assert.equal(total([{ price: 10, qty: 3 }]), 27)
})

test('quantities add up', () => {
  assert.equal(total([{ price: 5, qty: 1 }, { price: 15, qty: 2 }]), 31.5)
})
`)
{
  const [first] = readLog(tokyo.id), p = f => join(tokyo.path, f)
  let n = 0
  const call = (name, input, result) => {
    const id = 'toolu_' + ++n
    return [
      { type: 'assistant', uuid: 'a' + n, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } },
      { type: 'user', uuid: 'u' + n, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } },
    ]
  }
  const todos = { todos: ['Read src/cart.js', 'Add a 10% discount from 3 items', 'Cover the edge cases with tests', 'Run the test suite']
    .map(content => ({ content, status: 'completed', activeForm: content })) }
  writeLog(tokyo.id, [
    { ...first, text: 'Add a 10% discount to the cart from 3 items, with tests.' },
    { type: 'system', subtype: 'init', model: MODEL, session_id: 'd466084e-5b1f-4c52-9a3e-2f0c7b9e8a11' },
    { type: 'assistant', uuid: 'a0', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Let me look at how the cart computes its total first.' }] } },
    ...call('Read', { file_path: p('src/cart.js') }, cart),
    ...call('Edit', { file_path: p('src/cart.js'), old_string: '  return sum\n', new_string: '  const count = items.reduce((n, i) => n + i.qty, 0)\n  const off = count >= DISCOUNT_FROM ? sum * DISCOUNT : 0\n  return Math.round((sum - off) * 100) / 100\n' }, 'The file has been updated.'),
    ...call('Write', { file_path: p('test/cart.test.js'), content: '…' }, 'File created successfully.'),
    ...call('Bash', { command: 'node --test', description: 'Run the tests' }, '✔ no discount under 3 items\n✔ 10% off from 3 items\n✔ quantities add up\nℹ tests 3\nℹ pass 3\nℹ fail 0'),
    ...call('TodoWrite', todos, 'Todos have been modified successfully.'),
    { type: 'assistant', uuid: 'a9', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done. The discount applies **from 3 items** (quantities add up), rounded to the cent.\n\n- `src/cart.js`: new `DISCOUNT_FROM = 3` constant, applied in `total()`\n- `test/cart.test.js`: 3 tests, including the 2-item edge case\n\nAll tests pass. Want me to show the discount on the cart page?' }] } },
    { type: 'result', subtype: 'success', is_error: false, duration_ms: 47_000, total_cost_usd: 0.21, num_turns: 6 },
  ])
}

// ---- kyoto: done earlier ----
await srv.turn(kyoto.id, 'hello')
await title(kyoto, 'README: new endpoints')

// ---- oslo: asks before pushing (Ask mode, the permission card stays up) ----
await srv.api('PATCH', `/workspaces/${oslo.id}`, { permissionMode: 'default' })
const push = 'git push -u origin HEAD && gh pr create --fill'
await srv.api('POST', `/workspaces/${oslo.id}/send`, { text: 'bash ' + push })
await waitFor(async () => (await srv.ws(oslo.id)).pending?.length, { what: 'permission request' })
await title(oslo, 'Push and open the PR')
writeLog(oslo.id, readLog(oslo.id).map(e =>
  e.type === 'cg_user' ? { ...e, text: 'Push the branch and open the PR' }
  : e.type === 'system' ? { ...e, model: MODEL }
  : e.message?.content?.[0]?.name === 'Bash' ? { ...e, message: { content: [{ ...e.message.content[0], input: { command: push, description: 'Push and open the PR' } }] } }
  : e))

// ---- lima: working (the fake streams for ~10 s after each "slow") ----
await srv.turn(lima.id, 'hello')
await title(lima, 'Product list pagination')
const working = () => srv.api('POST', `/workspaces/${lima.id}/send`, { text: 'slow' })

// ---- shots ----
const browser = await chromium.launch()
async function shot(file, { ws = tokyo, tab = 'diff', dark = false, locale = 'en-US' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale, colorScheme: dark ? 'dark' : 'light' })
  await ctx.addInitScript(t => localStorage.setItem('aig.tab', t), tab)
  const page = await ctx.newPage()
  await working()
  await page.goto(`${srv.base}/#ws=${ws.id}`)
  await page.locator('#wsName').waitFor()
  await page.waitForLoadState('networkidle')
  await sleep(800)
  await page.screenshot({ path: join(OUT, file) })
  await ctx.close()
  console.log('✓', file)
}

await shot('hero.png')
await shot('hero-dark.png', { dark: true })
await shot('french.png', { locale: 'fr-FR' })
await shot('permissions.png', { ws: oslo })
await srv.api('POST', `/workspaces/${tokyo.id}/run`, {})
await sleep(1500) // the dev server is up before the page opens
await shot('run.png', { tab: 'run' })

await browser.close()
await srv.stop()
