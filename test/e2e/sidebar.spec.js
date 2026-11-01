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

  await page.getByRole('button', { name: 'Rename' }).click()
  await page.locator('#dlg input').fill('Login revamp')
  await page.locator('#dlg input').press('Enter')
  await expect(page.locator('#wsName')).toHaveText('Login revamp')
  await expect(page.locator('.wsItem.on .wsName')).toHaveText('Login revamp')
  await expect(page).toHaveTitle(/Login revamp · Aiguillage/)

  await page.getByRole('button', { name: 'Rename' }).click()
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
