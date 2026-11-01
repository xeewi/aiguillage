import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect, say } from './fixtures.js'

const lastReply = page => page.locator('#thread .msg.ai').last()

test('Demander: permission card, red dot while pending, Autoriser runs the tool', async ({ open, page }) => {
  const { w } = await open()
  await page.locator('#mode').selectOption('default')
  await say(page, 'write approved.txt yes')
  const card = page.locator('#perms .perm')
  await expect(card).toContainText('The agent wants to use Write')
  await expect(card.locator('pre')).toContainText('approved.txt')
  await expect(page.locator('.wsItem.on .pill.ask')).toBeVisible()
  await card.getByRole('button', { name: 'Allow' }).click()
  await expect(card).toHaveCount(0)
  await expect(lastReply(page)).toHaveText('wrote approved.txt')
  expect(readFileSync(join(w.path, 'approved.txt'), 'utf8')).toBe('yes\n')
})

test('Demander: Refuser denies the tool', async ({ open, page }) => {
  const { w } = await open()
  await page.locator('#mode').selectOption('default')
  await say(page, 'write denied.txt no')
  await page.locator('#perms .perm').getByRole('button', { name: 'Deny' }).click()
  await expect(lastReply(page)).toHaveText('write failed: Denied by the user.')
  expect(existsSync(join(w.path, 'denied.txt'))).toBe(false)
})

test('Auto: an edit outside the worktree is refused and shown as a failed tool', async ({ open, page }) => {
  await open()
  const outside = join(tmpdir(), `aiguillage-e2e-outside-${Date.now()}.txt`)
  await say(page, `write ${outside} nope`)
  await expect(page.locator('details.tool.bad')).toContainText('Write')
  await expect(lastReply(page)).toContainText('outside your worktree')
  expect(existsSync(outside)).toBe(false)
})

test('Plan: plan card renders markdown; "Valider le plan" switches to Auto', async ({ open, page }) => {
  await open()
  await page.locator('#mode').selectOption('plan')
  await say(page, 'plan add **docs** folder')
  const card = page.locator('#perms .perm')
  await expect(card).toContainText('The agent proposes this plan')
  await expect(card.locator('.plan h2')).toHaveText('Plan')
  await expect(card.locator('.plan strong')).toHaveText('docs')
  await card.getByRole('button', { name: /Approve the plan/ }).click()
  await expect(lastReply(page)).toHaveText('plan approved, mode now default')
  await expect(page.locator('#mode')).toHaveValue('auto')
})

test('Plan: rejecting asks for feedback and sends it to the agent', async ({ open, page }) => {
  await open()
  await page.locator('#mode').selectOption('plan')
  await say(page, 'plan rewrite everything')
  page.once('dialog', d => { expect(d.type()).toBe('prompt'); d.accept('too vague') })
  await page.locator('#perms .perm').getByRole('button', { name: /Reject with a comment/ }).click()
  await expect(lastReply(page)).toHaveText('plan rejected: too vague')
  await expect(page.locator('#mode')).toHaveValue('plan')
})

test('revert ↺: files and conversation go back, the message returns to the composer', async ({ open, page }) => {
  const { w } = await open()
  await say(page, 'write a.txt one')
  await expect(lastReply(page)).toHaveText('wrote a.txt')
  await say(page, 'write b.txt two')
  await expect(lastReply(page)).toHaveText('wrote b.txt')
  expect(existsSync(join(w.path, 'b.txt'))).toBe(true)

  const second = page.locator('#thread .msg.me').nth(1)
  await second.hover()
  page.once('dialog', d => { expect(d.type()).toBe('confirm'); d.accept() })
  await second.locator('.revert').click()

  await expect(page.locator('#input')).toHaveValue('write b.txt two')
  await expect(page.locator('#thread .msg.me')).toHaveCount(1)
  expect(existsSync(join(w.path, 'b.txt'))).toBe(false)
  expect(existsSync(join(w.path, 'a.txt'))).toBe(true)

  await say(page, 'memory')
  await expect(lastReply(page)).toHaveText('memory: write a.txt one | memory')
})

test('revert ↺ cancelled in the confirm dialog changes nothing', async ({ open, page }) => {
  const { w } = await open()
  await say(page, 'write keep.txt k')
  await expect(lastReply(page)).toHaveText('wrote keep.txt')
  const msg = page.locator('#thread .msg.me').first()
  await msg.hover()
  page.once('dialog', d => d.dismiss())
  await msg.locator('.revert').click()
  await expect(page.locator('#thread .msg.me')).toHaveCount(1)
  expect(existsSync(join(w.path, 'keep.txt'))).toBe(true)
})
