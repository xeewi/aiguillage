import { test as base, expect } from '@playwright/test'
import { startServer, makeRepo } from '../helpers.mjs'

// srv: an isolated server per test. open(files, opts): repo + workspace created via the API, page opened on it.
export const test = base.extend({
  srv: async ({}, use) => { const srv = await startServer(); await use(srv); await srv.stop() },
  open: async ({ srv, page }, use) => {
    await use(async (files, opts) => {
      const repoPath = makeRepo(files, opts)
      const repo = await srv.api('POST', '/repos', { path: repoPath })
      const w = await srv.api('POST', '/workspaces', { repoId: repo.id })
      await page.goto(`${srv.base}/#ws=${w.id}`)
      await expect(page.locator('#wsName')).toHaveText(w.name)
      return { repoPath, repo, w }
    })
  },
})
export { expect }

// Type into the composer and send with Enter.
export async function say(page, text) {
  await page.locator('#input').fill(text)
  await page.locator('#input').press('Enter')
}
// Last completed turn shows a result meta line.
export const results = page => page.locator('#thread .meta.ok')
