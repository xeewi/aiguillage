import { test, expect, say, results } from './fixtures.js'

test('Enter sends: user bubble, reply, result meta line', async ({ open, page }) => {
  await open()
  await say(page, 'hello agent')
  await expect(page.locator('#thread .msg.me .body')).toHaveText('hello agent')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('ok: hello agent')
  await expect(results(page)).toHaveText([/^\d+s · 1 turn$/])
  await expect(page.locator('#input')).toHaveValue('')
})

test('Shift+Enter inserts a newline instead of sending', async ({ open, page }) => {
  await open()
  await page.locator('#input').fill('line one')
  await page.locator('#input').press('Shift+Enter')
  await page.locator('#input').pressSequentially('line two')
  await expect(page.locator('#input')).toHaveValue('line one\nline two')
  await expect(page.locator('#thread .msg.me')).toHaveCount(0)
  await page.locator('#input').press('Enter')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('ok: line one\nline two')
})

test('streaming draft, busy indicator and Stop interrupting a long turn', async ({ open, page }) => {
  await open()
  await say(page, 'slow')
  await expect(page.locator('#thread .draft')).toContainText('tick 2')
  await expect(page.locator('#busy')).toBeVisible()
  await expect(page.locator('.wsItem.on .pill.run')).toBeVisible()
  await page.locator('#stop').click()
  await expect(page.locator('#busy')).toBeHidden()
  await expect(page.locator('#stop')).toBeHidden()
  await expect(page.locator('#thread .meta', { hasText: '[Request interrupted by user]' })).toBeVisible()
  await expect(page.locator('#thread .draft')).toHaveCount(0)
})

test('tool cards: Write shows its path and result, TodoWrite renders a styled list', async ({ open, page }) => {
  await open()
  await say(page, 'write notes/a.txt some content')
  const card = page.locator('details.tool', { hasText: 'Write' })
  await expect(card.locator('summary')).toContainText('notes/a.txt')
  await expect(card).toHaveClass(/done/)
  await card.locator('summary').click()
  await expect(card.locator('pre.out')).toContainText('File created successfully')

  await say(page, 'todo')
  const todos = page.locator('details.tool ul.todos')
  await expect(todos.locator('li')).toHaveText(['first step', 'second step', 'third step'])
  await expect(todos.locator('li.completed')).toHaveCSS('text-decoration-line', 'line-through')
  await expect(todos.locator('li.in_progress')).toHaveCSS('font-weight', '700')
})

test('agent markdown is rendered and sanitized (no script execution)', async ({ open, page }) => {
  await open()
  await say(page, 'markdown')
  const msg = page.locator('#thread .msg.ai').last()
  await expect(msg.locator('strong')).toHaveText('bold')
  await expect(msg.locator('pre code')).toHaveText('const a = 1')
  await expect(msg.locator('script')).toHaveCount(0)
  await expect(msg.locator('[onerror]')).toHaveCount(0)
  const hrefs = await msg.locator('a').evaluateAll(as => as.map(a => a.getAttribute('href') ?? ''))
  expect(hrefs.every(h => !/^\s*javascript:/i.test(h))).toBe(true)
  await page.waitForTimeout(200) // give a would-be onerror handler its chance
  expect(await page.evaluate(() => window.__xss)).toBeUndefined()
})

test('an agent crash is shown as an error and the next message works', async ({ open, page }) => {
  await open()
  await say(page, 'crash')
  await expect(page.locator('#thread .msg.err')).toContainText('simulated crash')
  await expect(page.locator('#busy')).toBeHidden()
  await expect(page.locator('.wsItem.on .pill.err')).toHaveText('Failed')
  await say(page, 'still alive?')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('ok: still alive?')
  await expect(page.locator('.wsItem.on .pill.err')).toHaveCount(0)
})
