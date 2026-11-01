import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, say } from './fixtures.js'
import { git } from '../helpers.mjs'

const act = (page, name) => page.locator('#wsHead .actions').getByRole('button', { name, exact: true })

test('Commit → Merge: refused while uncommitted, then merged into main', async ({ open, page }) => {
  const { w, repoPath } = await open()
  await say(page, 'write feature.txt shipped')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote feature.txt')

  page.once('dialog', d => d.accept())
  await act(page, 'Merge').click()
  await expect(page.locator('#toast.bad')).toContainText('uncommitted changes')

  page.once('dialog', d => { expect(d.type()).toBe('prompt'); d.accept('add feature') })
  await act(page, 'Commit').click()
  await expect(page.locator('#toast')).toHaveText('Commit created.')
  expect(git(w.path, 'log', '-1', '--format=%s')).toBe('add feature')

  page.once('dialog', d => { expect(d.message()).toContain(`Merge ${w.branch} into main`); d.accept() })
  await act(page, 'Merge').click()
  await expect(page.locator('#toast')).toContainText('Merged into main')
  expect(readFileSync(join(repoPath, 'feature.txt'), 'utf8')).toBe('shipped\n')
})

test('Commit cancelled in the prompt does nothing', async ({ open, page }) => {
  const { w } = await open()
  await say(page, 'write x.txt x')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote x.txt')
  page.once('dialog', d => d.dismiss())
  await act(page, 'Commit').click()
  await expect(page.locator('#toast')).toBeHidden()
  expect(git(w.path, 'status', '--porcelain')).toContain('x.txt')
})

test('Archiver → listed in Archivés → ↺ restores (work kept) → × deletes', async ({ srv, open, page }) => {
  const { w, repoPath } = await open()
  await say(page, 'write wip.txt draft')
  await expect(page.locator('#thread .msg.ai').last()).toHaveText('wrote wip.txt')

  page.once('dialog', d => { expect(d.message()).toContain('Archive'); d.accept() })
  await act(page, 'Archive').click()
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
  await act(page, 'Archive').click()
  await expect(archived).toBeVisible()
  if (!(await archived.evaluate(d => d.open))) await archived.locator('summary').click()
  page.once('dialog', d => { expect(d.message()).toContain('Delete'); d.accept() })
  await archived.locator('.wsItem', { hasText: w.name }).getByRole('button', { name: 'Delete' }).click()
  await expect(archived).toBeHidden()
  expect((await srv.state()).workspaces).toHaveLength(0)
  expect(git(repoPath, 'branch', '--list', w.branch)).toBe('')
})
