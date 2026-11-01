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
  // Nothing to ship yet: the git bar waits for a change.
  for (const name of ['Commit', 'Merge', 'Create PR']) await expect(page.locator('#gitBar').getByRole('button', { name })).toBeDisabled()

  await say(page, 'write café.txt bonjour')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote café.txt')
  const row = page.locator('#diffView details.file summary', { hasText: 'café.txt' })
  await expect(row).toContainText('+1')
  await expect(row).toContainText('−0')
  await expect(page.locator('#diffView .hint')).toHaveText('Uncommitted changes included.')
  await expect(page.locator('#gitBar').getByRole('button', { name: 'Create PR' })).toBeEnabled()
  await expect(page.locator('#diffStat')).toHaveText('1 file +1 −0')
  // The Diff tab keeps its counts while another tab is open.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(page.locator('#diffCount')).toHaveText('+1 −0')
  await page.locator('#tabs [data-tab="diff"]').click()
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
  await expect(page.locator('#runAsk')).toBeHidden()
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

test('Run tab without any script config: ▶ Run explains what to add, Ask the agent sends it the job', async ({ open, page }) => {
  await open()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('#runScript')).toBeHidden()
  await page.locator('#runStart').click()
  await expect(page.locator('#toast.bad')).toContainText('No run script')
  await page.locator('#runAsk').click()
  await expect(page.locator('#thread .msg.me .body')).toContainText('.aiguillage/settings.toml')
})

test('layout: collapsed sidebar, panel below, resized split; all survive a reload', async ({ open, page }) => {
  await open()
  const panel = page.locator('#panel')

  await page.getByRole('button', { name: 'Collapse the sidebar' }).click()
  await expect(page.locator('.wsItem.on .wsName')).toBeHidden()
  await expect(page.locator('.wsItem.on .bdg')).toBeVisible()

  await page.getByRole('button', { name: 'Panel below the chat' }).click()
  await expect(page.locator('#split')).toHaveClass(/below/)
  const h0 = (await panel.boundingBox()).height
  await page.locator('#gutter').focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await panel.boundingBox()).height).toBeGreaterThan(h0 + 5)
  const h1 = (await panel.boundingBox()).height

  await page.reload()
  await expect(page.getByRole('button', { name: 'Expand the sidebar' })).toBeVisible()
  await expect(page.locator('#split')).toHaveClass(/below/)
  await expect.poll(async () => Math.round((await panel.boundingBox()).height)).toBe(Math.round(h1))

  // Double-click resets to the default share; back beside the chat.
  await page.locator('#gutter').dblclick()
  await expect.poll(async () => Math.round((await panel.boundingBox()).height)).toBe(Math.round(h0))
  await page.getByRole('button', { name: 'Panel beside the chat' }).click()
  await expect(page.locator('#split')).not.toHaveClass(/below/)
})

test('narrow composer: model, effort and permissions fold into one chip that opens them', async ({ open, page }) => {
  await open()
  await expect(page.locator('#optsBtn')).toBeHidden()
  await page.setViewportSize({ width: 920, height: 700 }) // panel beside: the chat column is ~340px
  await expect(page.locator('#optsBtn')).toHaveText('Auto')
  await expect(page.locator('#mode')).toBeHidden()
  await page.locator('#optsBtn').click()
  await page.locator('#mode').selectOption('plan')
  await page.locator('#model').selectOption('opus')
  await expect(page.locator('#optsBtn')).toHaveText('Plan · Opus')
  await page.keyboard.press('Escape')
  await expect(page.locator('#mode')).toBeHidden()
})
