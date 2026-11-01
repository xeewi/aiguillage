import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startServer, setup, waitFor, git } from '../helpers.mjs'

let srv
before(async () => { srv = await startServer() })
after(() => srv.stop())

const userMsgs = async id => (await srv.log(id)).filter(e => e.type === 'cg_user')
const revert = (id, msgId) => srv.api('POST', `/workspaces/${id}/revert`, { msgId })

test('revert restores files, staged state, log and agent memory to before the chosen message', async () => {
  const { w } = await setup(srv, { 'a.txt': 'one\n', 'gone.txt': 'bye\n' })
  await srv.turn(w.id, 'write keep.txt k')
  // State just before message 2: modified + staged, deleted, created.
  writeFileSync(join(w.path, 'a.txt'), 'manual\n')
  git(w.path, 'add', 'a.txt')
  unlinkSync(join(w.path, 'gone.txt'))
  writeFileSync(join(w.path, 'untracked.txt'), 'u\n')
  await srv.turn(w.id, 'write later.txt x')
  await srv.turn(w.id, 'bash echo changed > a.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm agent')
  await srv.turn(w.id, 'bash echo again > gone.txt')

  const msg2 = (await userMsgs(w.id))[1]
  const r = await revert(w.id, msg2.id)
  assert.equal(r.text, 'write later.txt x')

  assert.equal(readFileSync(join(w.path, 'a.txt'), 'utf8'), 'manual\n')
  assert.equal(readFileSync(join(w.path, 'keep.txt'), 'utf8'), 'k\n')
  assert.equal(readFileSync(join(w.path, 'untracked.txt'), 'utf8'), 'u\n')
  assert.ok(!existsSync(join(w.path, 'later.txt')))
  assert.ok(!existsSync(join(w.path, 'gone.txt')))
  assert.equal(git(w.path, 'diff', '--cached', '--name-only'), 'a.txt', 'staged state restored')
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), msg2.cp.head, 'agent commit undone')

  assert.equal((await userMsgs(w.id)).length, 1, 'log truncated')
  assert.equal(await srv.turn(w.id, 'memory'), 'memory: write keep.txt k | memory', 'reverted turns forgotten')
  const argv = srv.fakeArgv().at(-1).argv
  assert.ok(argv.includes('--resume-session-at'))
  assert.equal(argv[argv.indexOf('--resume-session-at') + 1], msg2.prevUuid)
  assert.ok(argv.includes('--fork-session'))
})

test('reverting the first message drops the session', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'write first.txt 1')
  await revert(w.id, (await userMsgs(w.id))[0].id)
  assert.equal((await srv.ws(w.id)).sessionId, null)
  assert.ok(!existsSync(join(w.path, 'first.txt')))
  assert.deepEqual(await srv.log(w.id), [])
  assert.equal(await srv.turn(w.id, 'memory'), 'memory: memory')
  assert.ok(!srv.fakeArgv().at(-1).argv.includes('--resume'), 'fresh session')
})

test('revert is refused while the agent is working', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'hi')
  await srv.api('POST', `/workspaces/${w.id}/send`, { text: 'slow' })
  await waitFor(async () => (await srv.ws(w.id)).busy, { what: 'busy' })
  await assert.rejects(revert(w.id, (await userMsgs(w.id))[0].id), /Interrupt the agent/)
  await srv.api('POST', `/workspaces/${w.id}/interrupt`)
  await srv.idle(w.id, 5000)
  assert.equal((await userMsgs(w.id)).length, 2)
})

test('revert of an unknown message fails cleanly', async () => {
  const { w } = await setup(srv)
  await srv.turn(w.id, 'hi')
  await assert.rejects(revert(w.id, 'nope'), /checkpoint/)
})

test('no checkpoint while a merge is in progress, but the message still goes through', async () => {
  const { w } = await setup(srv)
  const mergeHead = resolve(w.path, git(w.path, 'rev-parse', '--git-path', 'MERGE_HEAD'))
  writeFileSync(mergeHead, git(w.path, 'rev-parse', 'HEAD') + '\n')
  try {
    assert.equal(await srv.turn(w.id, 'during merge'), 'ok: during merge')
    assert.equal((await userMsgs(w.id))[0].cp, null)
  } finally { unlinkSync(mergeHead) }
  await srv.turn(w.id, 'after merge')
  assert.ok((await userMsgs(w.id))[1].cp?.tree)
})

test('checkpoint refs live under refs/aiguillage/<id>/ and are removed on delete', async () => {
  const { w, repoPath } = await setup(srv)
  await srv.turn(w.id, 'one')
  await srv.turn(w.id, 'two')
  const refs = () => git(repoPath, 'for-each-ref', '--format=%(refname)', `refs/aiguillage/${w.id}/`).split('\n').filter(Boolean)
  assert.equal(refs().length, 2)
  await srv.api('DELETE', `/workspaces/${w.id}`)
  assert.deepEqual(refs(), [])
  assert.ok(!(await srv.state()).workspaces.some(x => x.id === w.id))
})
