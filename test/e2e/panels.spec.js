import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, say } from './fixtures.js'

const TOML = `[scripts]
setup = "echo setup-done-$AIGUILLAGE_WORKSPACE_NAME"

[scripts.run.web]
command = "echo serving-on-$AIGUILLAGE_PORT; sleep 30"
default = true

[scripts.run.hello]
command = "echo hello-run"
`

test('Diff tab: empty, then files with +/− counts, colored lines, unicode names; ↻ refresh', async ({ open, page }) => {
  const { w } = await open({ 'README.md': '# title\n' })
  await expect(page.locator('#diffView .hint')).toHaveText('No changes compared to the base branch.')

  await say(page, 'write café.txt bonjour')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote café.txt')
  const row = page.locator('#diffView details.file summary', { hasText: 'café.txt' })
  await expect(row).toContainText('+1')
  await expect(row).toContainText('−0')
  await expect(page.locator('#diffView .hint')).toHaveText('Uncommitted changes included.')
  const file = page.locator('#diffView details.file', { hasText: 'café.txt' })
  await expect(file.locator('pre.diff .add')).toHaveText('+bonjour')
  await expect(file.locator('pre.diff .add')).toHaveCSS('background-color', /rgb/)

  // A change made outside the agent shows up after ↻.
  writeFileSync(join(w.path, 'README.md'), '# title\nmore\n')
  await page.locator('#refresh').click()
  const readme = page.locator('#diffView details.file', { hasText: 'README.md' })
  await expect(readme.locator('pre.diff .add')).toHaveText('+more')
  await expect(readme.locator('pre.diff .hunk')).toHaveCount(1)
})

test('Terminal tab: a real shell in the worktree with workspace env', async ({ open, page }) => {
  const { w } = await open()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const term = page.locator('#termView .xterm')
  await expect(term).toBeVisible()
  await term.click()
  await page.keyboard.type('echo hi-$AIGUILLAGE_WORKSPACE_NAME && pwd\n')
  await expect(page.locator('#termView .xterm-rows')).toContainText(`hi-${w.name}`)
  await expect(page.locator('#termView .xterm-rows')).toContainText(w.name)
})

test('Run tab: setup output, named scripts from .aiguillage/settings.toml, Run / Stop, sidebar tag, port link', async ({ open, page }) => {
  const { w } = await open({ 'README.md': '#\n', '.aiguillage/settings.toml': TOML })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const out = page.locator('#runTerm .xterm-rows')
  await expect(out).toContainText(`setup-done-${w.name}`)
  await expect(page.locator('#runScript option')).toHaveText(['web', 'hello'])
  await expect(page.locator('#runScript')).toHaveValue('web')
  await expect(page.locator('#runPort')).toHaveText(`http://localhost:${w.port}`)
  await expect(page.locator('#runPort')).toHaveAttribute('href', `http://localhost:${w.port}`)

  await page.locator('#runStart').click()
  await expect(out).toContainText(`serving-on-${w.port}`)
  await expect(page.locator('.wsItem.on .pill.script')).toHaveText('web')
  await page.locator('#runStop').click()
  await expect(page.locator('.wsItem.on .pill.script')).toHaveCount(0)
  await expect(out).toContainText('[exited')

  await page.locator('#runScript').selectOption('hello')
  await page.locator('#runStart').click()
  await expect(out).toContainText('hello-run')
})

test('Run tab without any script config: ▶ Run explains what to add', async ({ open, page }) => {
  await open()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('#runScript')).toBeHidden()
  await page.locator('#runStart').click()
  await expect(page.locator('#toast.bad')).toContainText('No run script')
})
