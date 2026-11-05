import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { startServer, tmp } from '../helpers.mjs'

test('first run: done steps are ticked, the next one has a button that runs it in a terminal', async ({ page }) => {
  const srv = await startServer({ env: { FAKE_CLAUDE_LOGGED_OUT: '1' } })
  try {
    await page.goto(srv.base)
    const steps = page.locator('#steps li')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toHaveClass('done')
    await expect(steps.nth(1)).toHaveClass('done')
    await expect(page.locator('#emptyAdd')).toBeHidden()
    await steps.nth(2).getByRole('button', { name: 'Sign in' }).click()
    await expect(page.locator('#setupTerm')).toContainText('auth login')
    await page.screenshot({ path: process.env.SHOT || 'test-results/setup.png' })
  } finally { await srv.stop() }
})

test('add repo: a plain folder is offered to become a git repo', async ({ page }) => {
  const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const srv = await startServer({ env: id })
  try {
    const dir = tmp('cgplain-'); writeFileSync(join(dir, 'notes.txt'), 'hi')
    await page.goto(srv.base)
    await page.locator('#emptyAdd').click()
    await expect(page.getByRole('button', { name: 'Choose a folder…' })).toBeVisible()
    await page.screenshot({ path: process.env.SHOT2 || 'test-results/add.png' })
    await page.locator('#dlg input').fill(dir)
    page.once('dialog', d => { expect(d.message()).toContain('not a git repo yet'); d.accept() })
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.locator('.repoHead').last()).toContainText(basename(dir))
  } finally { await srv.stop() }
})
