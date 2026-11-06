import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, say } from './fixtures.js'
import { git } from '../helpers.mjs'

// Commit / Merge / PR sit in the Diff tab's bar; Archive in the header's ⋯ menu.
const act = (page, name) => page.locator('#gitBar').getByRole('button', { name, exact: true })
async function archive(page) {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.locator('#moreMenu').getByRole('button', { name: 'Archive' }).click()
}

test('Commit → Merge: refused while uncommitted, then merged into main', async ({ open, page }) => {
  const { w, repoPath } = await open()
  await say(page, 'write feature.txt shipped')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote feature.txt')

  page.once('dialog', d => d.accept())
  await act(page, 'Merge').click()
  await expect(page.locator('#toast.bad')).toContainText('uncommitted changes')

  await act(page, 'Commit').click()
  const msg = page.locator('#dlg').getByLabel('Commit message')
  await expect(msg).toBeFocused()
  await msg.fill('add feature')
  await msg.press('Enter')
  await expect(page.locator('#toast')).toHaveText('Commit created.')
  expect(git(w.path, 'log', '-1', '--format=%s')).toBe('add feature')

  page.once('dialog', d => { expect(d.message()).toContain(`Merge ${w.branch} into main`); d.accept() })
  await act(page, 'Merge').click()
  await expect(page.locator('#toast')).toContainText('Merged into main')
  expect(readFileSync(join(repoPath, 'feature.txt'), 'utf8')).toBe('shipped\n')
})

test('Commit cancelled in its dialog does nothing; the message starts from the task name', async ({ open, page }) => {
  const { w } = await open()
  await say(page, 'write x.txt x')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote x.txt')
  await act(page, 'Commit').click()
  await expect(page.locator('#dlg').getByLabel('Commit message')).toHaveValue('Named: write x.txt x')
  await page.locator('#dlg').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('#dlg')).toBeHidden()
  await expect(page.locator('#toast')).toBeHidden()
  expect(git(w.path, 'status', '--porcelain')).toContain('x.txt')
})

test('Archiver → listed in Archivés → ↺ restores (work kept) → × deletes', async ({ srv, open, page }) => {
  const { w, repoPath } = await open()
  await say(page, 'write wip.txt draft')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote wip.txt')

  page.once('dialog', d => { expect(d.message()).toContain('Archive'); d.accept() })
  await archive(page)
  await expect(page.locator('#repos .wsItem')).toHaveCount(0)
  await expect(page.locator('#empty')).toBeVisible()
  expect(existsSync(w.path)).toBe(false)

  const archived = page.locator('#archived')
  await archived.locator('summary').click()
  const row = archived.locator('.wsItem', { hasText: w.name })
  await expect(row).toContainText('write wip.txt draft')
  await row.getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('#wsBranch')).toContainText(w.branch)
  await expect(page.locator('#repos .wsItem')).toHaveCount(1)
  expect(readFileSync(join(w.path, 'wip.txt'), 'utf8')).toBe('draft\n')
  await expect(page.locator('#thread .msg.me')).toHaveCount(1) // conversation kept

  page.once('dialog', d => d.accept())
  await archive(page)
  await expect(archived).toBeVisible()
  if (!(await archived.evaluate(d => d.open))) await archived.locator('summary').click()
  page.once('dialog', d => { expect(d.message()).toContain('Delete'); d.accept() })
  await archived.locator('.wsItem', { hasText: w.name }).getByRole('button', { name: 'Delete' }).click()
  await expect(archived).toBeHidden()
  expect((await srv.state()).workspaces).toHaveLength(0)
  expect(git(repoPath, 'branch', '--list', w.branch)).toBe('')
})

test('right-click a session in the sidebar → Archive it without opening it; right-click the archived row → Restore', async ({ srv, open, page }) => {
  const { w } = await open()
  const other = await srv.api('POST', '/workspaces', { repoId: w.repoId })
  const item = page.locator('#repos .wsItem', { hasText: other.name })
  await item.click({ button: 'right' })
  await expect(page.locator('#ctxMenu')).toBeVisible()
  await expect(page.locator('#wsBranch')).toContainText(w.branch) // still on the open session
  page.once('dialog', d => { expect(d.message()).toContain(other.name); d.accept() })
  await page.locator('#ctxMenu').getByRole('button', { name: 'Archive' }).click()
  await expect(page.locator('#repos .wsItem')).toHaveCount(1)
  await expect(page.locator('#wsBranch')).toContainText(w.branch)

  await page.locator('#archived summary').click()
  await page.locator('#archived .wsItem', { hasText: other.name }).click({ button: 'right' })
  await page.locator('#ctxMenu').getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('#repos .wsItem')).toHaveCount(2)
  await expect(page.locator('#wsBranch')).toContainText(other.branch) // restore opens it, as the ↺ button does
})

test('right-click → Mark as unread survives a reload, opening the session clears it; ⇧⌘A archives the open one', async ({ srv, open, page }) => {
  const { w } = await open()
  const other = await srv.api('POST', '/workspaces', { repoId: w.repoId })
  const item = page.locator('#repos .wsItem', { hasText: other.name })
  await item.click({ button: 'right' })
  await page.locator('#ctxMenu').getByRole('button', { name: 'Mark as unread' }).click()
  await expect(item.locator('.pill.new')).toBeVisible()
  await page.reload()
  await expect(item.locator('.pill.new')).toBeVisible()
  await item.click({ button: 'right' })
  await expect(page.locator('#ctxMenu').getByRole('button', { name: 'Mark as read' })).toBeVisible()
  await page.keyboard.press('Escape')
  await item.click()
  await expect(item.locator('.pill.new')).toHaveCount(0)

  page.once('dialog', d => { expect(d.message()).toContain(other.name); d.accept() })
  await page.keyboard.press('ControlOrMeta+Shift+A')
  await expect(page.locator('#repos .wsItem')).toHaveCount(1)
  await expect(page.locator('#empty')).toBeVisible()
})

test('check: Run check shows the verdict, « out of date » once files move, and archiving the workspace breaks nothing', async ({ open, page }) => {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await open({ '.aiguillage/settings.toml': '[scripts]\ncheck = "test -f ok.txt"\n' })
  const badge = page.locator('#checkBadge')
  await act(page, 'Run check').click()
  await expect(badge).toHaveText('🧪 check failed')
  await say(page, 'write ok.txt yes') // the turn's own check runs and passes
  await expect(badge).toHaveText('🧪 check passed')
  await say(page, 'write later.txt l')
  await expect(badge).toHaveText(/passed|running|out of date/) // settles on the new check
  page.once('dialog', d => d.accept())
  await archive(page)
  await expect(page.locator('#ws')).toBeHidden()
  await page.waitForTimeout(300)
  expect(errors).toEqual([])
})
