import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, say, results } from './fixtures.js'
import { git, makeRepo } from '../helpers.mjs'

test('empty state → add a repo from the suggestions; invalid path shows an error toast', async ({ srv, page }) => {
  // A repo under the (fake) HOME/code is suggested.
  const repo = join(srv.home, 'code', 'myproj')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')

  await page.goto(srv.base)
  await expect(page.getByRole('heading', { name: /Several Claude Code agents/ })).toBeVisible()

  await page.locator('#emptyAdd').click()
  await expect(page.locator('#dlg')).toBeVisible()
  await page.locator('#dlg .suggest button', { hasText: 'myproj' }).click()
  await expect(page.locator('#dlg input')).toHaveValue(repo)
  await page.locator('#dlg').getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.repoHead', { hasText: 'myproj' })).toBeVisible()

  await page.locator('#addRepo').click()
  await page.locator('#dlg input').fill('/definitely/not/a/repo')
  await page.locator('#dlg').getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('#toast.bad')).toContainText('is not a git repo')
})

test('"+" creates a selected workspace; ⌘/Ctrl+1/2 switches; the URL hash survives a reload', async ({ srv, page }) => {
  const repo = await srv.api('POST', '/repos', { path: makeRepo() })
  await page.goto(srv.base)
  const plus = page.locator('.repoHead', { hasText: 'repo' }).getByRole('button', { name: 'New workspace' })

  await plus.click()
  await expect(page.locator('#wsName')).toHaveText('tokyo')
  await expect(page.locator('#wsBranch')).toHaveText('aig/tokyo ← main')
  await expect(page.locator('#thread .hint')).toContainText('Worktree ready in')
  await expect(page.locator('.wsItem.on .wsName')).toHaveText('tokyo')

  await plus.click()
  await expect(page.locator('#wsName')).toHaveText('lima')
  expect(page.url()).toContain('#ws=')

  await page.keyboard.press('Control+1')
  await expect(page.locator('#wsName')).toHaveText('tokyo')
  await page.keyboard.press('Control+2')
  await expect(page.locator('#wsName')).toHaveText('lima')

  await page.reload()
  await expect(page.locator('#wsName')).toHaveText('lima')
  expect((await srv.state()).workspaces.filter(w => w.repoId === repo.id)).toHaveLength(2)
})

test('model and effort selects persist across a reload', async ({ open, page }) => {
  await open()
  await page.locator('#model').selectOption('sonnet')
  await page.locator('#effort').selectOption('high')
  await page.reload()
  await expect(page.locator('#model')).toHaveValue('sonnet')
  await expect(page.locator('#effort')).toHaveValue('high')
})

test('a turn finishing in another workspace marks it unread (blue dot) until selected', async ({ srv, open, page }) => {
  const { repo, w } = await open()
  const other = await srv.api('POST', '/workspaces', { repoId: repo.id })
  // Stay on the first workspace while the second one works.
  await srv.turn(other.id, 'background job')
  const item = page.locator('.wsItem', { hasText: other.name })
  await expect(item.locator('.pill.new')).toBeVisible()
  await item.click()
  await expect(page.locator('#wsBranch')).toContainText(other.branch)
  await expect(item.locator('.pill.new')).toHaveCount(0)
  await expect(results(page)).toHaveCount(1)
  expect(w.id).not.toBe(other.id)
})

test('the workspace is named by Claude from the first message, and can be renamed', async ({ open, page }) => {
  const { w } = await open()
  await expect(page.locator('.wsItem.on .wsTitle')).toHaveText('New workspace')
  await say(page, 'refactor the login page')
  await expect(page.locator('.wsItem.on .wsName')).toHaveText('Named: refactor the login page')
  await expect(page.locator('.wsItem.on .wsTitle')).toHaveText(w.name)
  await expect(page.locator('#wsName')).toHaveText('Named: refactor the login page')

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.locator('#moreMenu').getByRole('button', { name: 'Rename' }).click()
  await page.locator('#dlg input').fill('Login revamp')
  await page.locator('#dlg input').press('Enter')
  await expect(page.locator('#wsName')).toHaveText('Login revamp')
  await expect(page.locator('.wsItem.on .wsName')).toHaveText('Login revamp')
  await expect(page).toHaveTitle(/Login revamp · Aiguillage/)

  await page.locator('#wsName').dblclick() // shortcut to the same dialog
  await page.locator('#dlg').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('#wsName')).toHaveText('Login revamp')
})

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' })

  test('the UI follows the browser language, server errors are translated, the picker switches back to English', async ({ open, page }) => {
    await open()
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
    await expect(page.locator('#composer button[type=submit]')).toHaveText('Envoyer')
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /Demande quelque chose/)
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await page.locator('#runStart').click()
    await expect(page.locator('#toast.bad')).toContainText('Aucun script run')

    await page.getByRole('button', { name: 'Réglages' }).click()
    await page.locator('#lang').selectOption('en')
    await expect(page.locator('#composer button[type=submit]')).toHaveText('Send')
    await page.reload()
    await expect(page.locator('#composer button[type=submit]')).toHaveText('Send')
  })
})

test.describe('on a dark OS', () => {
  test.use({ colorScheme: 'dark' })

  test('the theme follows the OS, the picker pins light across reloads, System hands it back', async ({ open, page }) => {
    await open()
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await expect.poll(bg).toBe('rgb(17, 19, 21)')
    await page.locator('#openSettings').click()
    await page.locator('#theme').selectOption('light')
    await expect.poll(bg).toBe('rgb(255, 255, 255)')
    await page.reload()
    await expect(page.locator('#theme')).toHaveValue('light')
    await expect.poll(bg).toBe('rgb(255, 255, 255)')
    await page.locator('#theme').selectOption('system')
    await expect.poll(bg).toBe('rgb(17, 19, 21)')
  })
})

test('Settings page: defaults preselect new workspaces, repo base branch is editable, Escape goes back', async ({ open, page }) => {
  const { w } = await open()
  await page.locator('#openSettings').click()
  await expect(page.locator('#settings')).toBeVisible()
  await expect(page.locator('#ws')).toBeHidden()
  await page.locator('#defModel').selectOption('sonnet')
  await page.locator('#defEffort').selectOption('high')
  await page.locator('#defMode').selectOption('plan')
  await expect(page.locator('#setRepos .setRepo')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('#wsName')).toHaveText(w.name)
  await page.locator('.repoHead', { hasText: 'repo' }).getByRole('button', { name: 'New workspace' }).click()
  await expect(page.locator('#model')).toHaveValue('sonnet')
  await expect(page.locator('#effort')).toHaveValue('high')
  await expect(page.locator('#mode')).toHaveValue('plan')
})

test('Settings, desktop app: « Check now » asks for a check and shows what it finds', async ({ srv, page }) => {
  // Tests run unpackaged (updates off): the state broadcasts are proxied to play the updater's states.
  let update = { state: 'idle', version: '0.3.0' }, last, push
  await page.routeWebSocket(/./, ws => {
    const server = ws.connectToServer()
    const patch = m => { const j = JSON.parse(m); if (j.t === 'state') j.update = update; return JSON.stringify(j) }
    server.onMessage(m => { if (JSON.parse(m).t === 'state') last = m; ws.send(patch(m)) })
    push = u => { update = u; if (last) ws.send(patch(last)) }
  })
  let asked = 0
  // The real route answers (a 404 here would mean the router can't reach it); the proxy then plays « checking ».
  await page.route('**/api/check-update', async r => { const res = await r.fetch(); if (res.ok()) asked++; push({ ...update, state: 'checking' }); return r.fulfill({ response: res }) })
  await page.goto(srv.base + '/#settings')
  const note = page.locator('#updateNote'), btn = page.getByRole('button', { name: 'Check now' })
  await expect(note).toHaveText('Version 0.3.0') // idle at launch: not « up to date » until a check says so
  await btn.click()
  await expect(note).toHaveText('Version 0.3.0 · Checking…')
  await expect(btn).toBeDisabled()
  push({ ...update, state: 'idle' })
  await expect(note).toHaveText("Version 0.3.0 · You're up to date")
  await expect(btn).toBeEnabled()
  push({ ...update, state: 'downloading', latest: '0.4.0' })
  await expect(note).toContainText('Downloading Aiguillage 0.4.0')
  await expect(btn).toBeDisabled()
  expect(asked).toBe(1)
})

test('plan usage: session and week lanes over Settings, red past 90 %, every limit on hover', async ({ srv, page }) => {
  await page.goto(srv.base)
  const lanes = page.locator('#usage .lane')
  await expect(lanes).toHaveCount(2)
  await expect(lanes.nth(0)).toContainText(/Session\s*42%/)
  await expect(lanes.nth(0)).not.toHaveClass(/hot/)
  await expect(lanes.nth(0).locator('.when')).toHaveText(/resets in (1h 59m|2h 00m)/)
  await expect(lanes.nth(1)).toHaveClass(/hot/)
  await page.locator('#usage').hover()
  await expect(page.locator('#usagePop')).toBeVisible()
  await expect(page.locator('#usagePop tr')).toHaveCount(3)
  await expect(page.locator('#usagePop')).toContainText('Opus')
  await expect(page.locator('#usagePop')).toContainText('Max plan')
})

test('a long workspace list scrolls on its own: brand and Settings stay on screen', async ({ srv, page }) => {
  const repo = await srv.api('POST', '/repos', { path: makeRepo() })
  for (let i = 0; i < 12; i++) await srv.api('POST', '/workspaces', { repoId: repo.id })
  await page.setViewportSize({ width: 1000, height: 500 })
  await page.goto(srv.base)
  await expect(page.locator('#repos .wsItem')).toHaveCount(12)
  await page.locator('#repos').evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('#openSettings')).toBeInViewport()
  await expect(page.locator('#sideToggle')).toBeInViewport()
  expect(await page.locator('#side').evaluate(el => el.scrollTop)).toBe(0)
})

test('the aiguilleur sits on top of the sidebar and opens as a chat of its own, without the worktree panel', async ({ srv, page }) => {
  const repo = await srv.api('POST', '/repos', { path: makeRepo() })
  await srv.api('POST', '/workspaces', { repoId: repo.id })
  await page.goto(srv.base)
  const item = page.locator('#aiguilleur .wsItem')
  await expect(item.locator('.wsName')).toHaveText('Aiguilleur')
  await item.click()
  await expect(page.locator('#wsName')).toHaveText('Aiguilleur')
  await expect(page.locator('#thread .hint')).toContainText('relays your instructions')
  await expect(page.locator('#panel')).toBeHidden()
  await expect(page.locator('#wsHead .actions')).toBeHidden()
  await say(page, 'where are we?')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('ok: where are we?')
  await expect(item).toHaveClass(/on/)
  // Back to a workspace: its branch and panel are back.
  await page.locator('#repos .wsItem').first().click()
  await expect(page.locator('#panel')).toBeVisible()
  await expect(page.locator('#wsBranch')).toHaveText('aig/tokyo ← main')
})

test("an agent's finished turn shows in the aiguilleur's chat as a report that opens its workspace", async ({ srv, page }) => {
  const repo = await srv.api('POST', '/repos', { path: makeRepo() })
  const w = await srv.api('POST', '/workspaces', { repoId: repo.id })
  await page.goto(srv.base)
  await page.locator('#aiguilleur .wsItem').click()
  await srv.turn(w.id, 'fix the login')
  const report = page.locator('#thread .msg.report')
  await expect(report).toContainText('ok: fix the login')
  await expect(report.locator('.head')).toContainText(`${repo.name} / `)
  await say(page, 'and now?')
  // The aiguilleur's model read the report first; the window shows only what the user typed.
  await expect(page.locator('#thread .msg.me').last()).toHaveText('and now?')
  await expect(page.locator('#thread .msg.ai').last()).toContainText('[Reports from the agents since your last message]')
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
  await report.locator('.head').click()
  await expect(page.locator('#panel')).toBeVisible()
  await expect(page.locator('#wsBranch')).toHaveText(`${w.branch} ← main`)
})
