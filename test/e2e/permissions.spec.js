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
  await page.locator('#perms .perm').getByRole('button', { name: /Reject with a comment/ }).click()
  const feedback = page.locator('#dlg input')
  await expect(feedback).toBeFocused()
  await feedback.fill('too vague')
  await feedback.press('Enter')
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

test("the aiguilleur's merge request is a card in its chat; Allow merges and the outcome shows as a report", async ({ srv, open, page }) => {
  const { w } = await open()
  await srv.asAiguilleur('POST', `/workspaces/${w.id}/merge`)
  await page.locator('#aiguilleur .wsItem').click()
  const card = page.locator('#perms .perm')
  await expect(card).toContainText('The aiguilleur asks to:')
  await expect(card.locator('pre')).toHaveText(`Merge ${w.branch} into main`)
  await card.getByRole('button', { name: 'Allow' }).click()
  await expect(card).toHaveCount(0)
  await expect(page.locator('#thread .msg.report').last()).toContainText('Merged into main')
})

test("a report whose check failed looks bad in the window and shows the check's output", async ({ open, page }) => {
  await open({ 'README.md': '# t\n', '.aiguillage/settings.toml': '[scripts]\ncheck = "echo broken-build; exit 3"\n' })
  await say(page, 'write a.txt a')
  await page.locator('#aiguilleur .wsItem').click()
  const rep = page.locator('#thread .msg.report').last()
  await expect(rep).toContainText('🧪 check failed (exit 3)')
  await expect(rep).toHaveClass(/\bbad\b/)
  await expect(rep.locator('pre')).toContainText('broken-build')
})

test('a report waiting on the user looks so in the window; a turn the user stopped, neutral and « Stopped »', async ({ srv, open, page }) => {
  const { w } = await open()
  await say(page, 'report decision Which DB?')
  await expect(page.locator('#thread .meta.ok')).toBeVisible()
  await say(page, 'slow')
  await expect(page.locator('#thread .draft')).toContainText('tick 2')
  await page.locator('#stop').click()
  await expect(page.locator('#busy')).toBeHidden()
  // Both reports written before the chat opens: one landing while it loads would be wiped (loadThread).
  await expect.poll(async () => (await srv.log('aiguilleur')).filter(e => e.type === 'cg_report' && e.ws === w.id).length).toBe(2)
  await page.locator('#aiguilleur .wsItem').click()
  const [wait, stopped] = [page.locator('#thread .msg.report').first(), page.locator('#thread .msg.report').nth(1)]
  await expect(wait).toContainText('Which DB?')
  await expect(wait).toHaveClass(/\bwait\b/)
  await expect(stopped).toContainText('Stopped')
  await expect(stopped).toHaveClass(/\bstopped\b/)
  await expect(stopped).not.toHaveClass(/\bbad\b/)
})

test('a send past the agent cap asks first: Cancel queues it, OK sends it at once', async ({ srv, open, page }) => {
  const { repo, w } = await open()
  const other = await srv.api('POST', '/workspaces', { repoId: repo.id })
  await srv.api('PATCH', '/defaults', { maxAgents: 1 })
  await srv.api('POST', `/workspaces/${other.id}/send`, { text: 'hang 3000' })
  await expect.poll(async () => (await srv.ws(other.id)).busy).toBe(true)
  let asked
  page.once('dialog', d => { asked = d.message(); d.dismiss() })
  await say(page, 'queue me')
  await expect(page.locator('#toast')).toContainText('Queued')
  expect(asked).toMatch(/Agents at work: 1 \(max 1\)/)
  expect((await srv.ws(w.id)).queued.length).toBe(1)
  page.once('dialog', d => d.accept())
  await say(page, 'send now')
  await expect(page.locator('#thread .msg.me', { hasText: 'send now' })).toBeVisible()
})

test('a queued message shows over the composer, why and since when; Cancel takes it out and it is never sent', async ({ srv, open, page }) => {
  const { repo, w } = await open()
  const other = await srv.api('POST', '/workspaces', { repoId: repo.id })
  await srv.api('PATCH', '/defaults', { maxAgents: 1 })
  await srv.api('POST', `/workspaces/${other.id}/send`, { text: 'hang 3000' })
  await expect.poll(async () => (await srv.ws(other.id)).busy).toBe(true)
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'wait for me\nsecond line', queue: true })
  const row = page.locator('#queued .task')
  await expect(page.locator('#queued .tasksHead')).toHaveText('1 message waiting to be sent')
  await expect(row.locator('b')).toHaveText('wait for me')
  await expect(row.locator('.mono')).toContainText('agent cap')
  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('#queued')).toBeHidden()
  expect((await srv.ws(w.id)).queued).toEqual([])
  await expect.poll(async () => (await srv.ws(other.id)).busy, { timeout: 8000 }).toBe(false)
  await page.waitForTimeout(300)
  expect((await srv.log(w.id)).some(e => e.type === 'cg_user')).toBe(false)
})

test.describe('in French', () => {
  test.use({ locale: 'fr-FR' })

  test("a report written by Aiguillage itself shows in the window's language", async ({ srv, open, page }) => {
    const { w } = await open()
    const { pending } = await srv.asAiguilleur('POST', `/workspaces/${w.id}/archive`)
    await srv.api('POST', '/workspaces/aiguilleur/permission', { id: pending, allow: false })
    await page.locator('#aiguilleur .wsItem').click()
    await expect(page.locator('#thread .msg.report').last()).toContainText(`Vous avez refusé : Archiver ${w.name}`)
  })

  test('a brief to confirm reads in French around the brief as the agent will read it', async ({ srv, open, page }) => {
    const { repo, w } = await open()
    const w2 = await srv.api('POST', '/workspaces', { repoId: repo.id })
    await srv.turn(w.id, 'write src/auth.js x')
    await srv.asAiguilleur('POST', `/workspaces/${w2.id}/brief`, { goal: 'Fix login', scope: ['src'] })
    await page.locator('#aiguilleur .wsItem').click()
    const pre = page.locator('#perms .perm pre')
    await expect(pre).toContainText(/Ce que l'agent lira :\s+Task brief\s+Goal: Fix login/)
    await expect(pre).toContainText(/⚠️ chevauche .+ : src\/auth\.js/)
  })
})
