import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync, realpathSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)

// timeout (ms): killed past it, and rejects. Only where a call is never legitimately long (snapshot): push, fetch and
// merge can be.
export async function git(cwd, args, env, timeout = 0) {
  const { stdout } = await exec('git', args, {
    cwd, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env, timeout, killSignal: 'SIGKILL',
  })
  return stdout
}

export async function isRepo(path) {
  try { return (await git(path, ['rev-parse', '--show-toplevel'])).trim() } catch { return null }
}

export async function defaultBranch(repo) {
  try {
    return (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '')
  } catch {
    return (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).trim() // works before the first commit too
  }
}

export async function branches(repo) {
  return (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean)
}

// --no-track: starting from origin/<base> must not make `git push` target the base branch.
export const addWorktree = (repo, path, branch, start) => git(repo, ['worktree', 'add', '--no-track', '-b', branch, path, start])

// Untracked files of the main checkout matching gitignore-style patterns (git does the matching).
export async function untrackedMatching(repo, { from, patterns = [] }) {
  const args = ['ls-files', '-z', '--others', '--ignored', ...(from ? [`--exclude-from=${from}`] : []), ...patterns.map(p => `--exclude=${p}`)]
  return (await git(repo, args)).split('\0').filter(Boolean)
}

// The project's logo, if it has one: tracked or untracked (not ignored) files named logo*, icon*, favicon*…
// Best pick: by name (logo first), then shallowest, then format (vector first). Path relative to the repo, or null.
const LOGO = /^(logo|app-?icon|icon|apple-touch-icon|favicon)([._-][\w.-]*)?\.(svg|png|webp|ico|jpe?g)$/i
const NAMES = ['logo', 'appicon', 'app-icon', 'icon', 'apple-touch-icon', 'favicon'], EXTS = ['svg', 'png', 'webp', 'ico', 'jpg', 'jpeg']
export async function findLogo(repo) {
  const files = (await git(repo, ['ls-files', '-z', '-co', '--exclude-standard', '--', ':(icase)*logo*', ':(icase)*icon*'])).split('\0')
  const score = f => {
    const m = f.split('/').pop().match(LOGO)
    return [NAMES.indexOf(m[1].toLowerCase()), f.split('/').length, EXTS.indexOf(m[3].toLowerCase()), f.length]
  }
  const hits = files.filter(f => LOGO.test(f.split('/').pop()) && !/(^|\/)(node_modules|vendor|tests?|fixtures|__tests__)\//.test(f)).map(f => [score(f), f])
  hits.sort(([a], [b]) => { const i = a.findIndex((v, j) => v !== b[j]); return i < 0 ? 0 : a[i] - b[i] })
  return hits[0]?.[1] ?? null
}

// A folder that is its own worktree root (not just inside some repo: git would walk up to an ancestor's).
export const isRoot = async path => existsSync(path) && await isRepo(path).then(t => t && realpathSync(t) === realpathSync(path))

// A worktree folder that lost its .git (only leftovers, e.g. ignored build caches) is deleted as git would have:
// git refuses to remove it, and a folder left there would block unarchive's `worktree add`.
export async function removeWorktree(repo, path) {
  if (await isRoot(path)) await git(repo, ['worktree', 'remove', '--force', path])
  else rmSync(path, { recursive: true, force: true })
  await git(repo, ['worktree', 'prune'])
}

// Everything the workspace changed vs. where it forked from base: commits, uncommitted edits and new files.
// One call: diff the fork point against a snapshot tree of the working copy (tree: one already taken).
export async function diff(cwd, base, tree) {
  const mb = (await git(cwd, ['merge-base', 'HEAD', base])).trim()
  tree ??= (await snapshot(cwd)).tree
  return git(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-color', mb, tree])
}

export async function status(cwd) {
  return (await git(cwd, ['status', '--porcelain'])).trim()
}

// ponytail: bounds the git work around a turn (lib/review.js inspect, lib/agent.js end-of-turn snapshot, each snapshot()
// git call), so a hung git can't stall a workspace's reports or sends forever, nor stay running.
export const GIT_TIMEOUT = 60_000

// Tests only (AIGUILLAGE_TEST): how many snapshots were taken per folder (server.js GET /api/counters).
const counting = !!process.env.AIGUILLAGE_TEST
export const snapshots = new Map()

// Checkpoint = HEAD + staged index + a tree of the full working copy (tracked + untracked, minus ignored),
// written through a throwaway index so the user's real index is never touched.
// timeout: each git call's (0: none, for archive, which must not fail on a huge worktree).
export async function snapshot(cwd, { timeout = GIT_TIMEOUT } = {}) {
  if (counting) snapshots.set(cwd, (snapshots.get(cwd) ?? 0) + 1)
  const dir = mkdtempSync(join(tmpdir(), 'aig-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const g = (args, e) => git(cwd, args, e, timeout) // a hung one is killed; the finally below still cleans up
    const head = (await g(['rev-parse', 'HEAD'])).trim()
    // A copy of the real index: write-tree on the real one takes index.lock and would make the user's (or another
    // agent's) git add/commit fail while a snapshot runs.
    const real = resolve(cwd, (await g(['rev-parse', '--git-path', 'index'])).trim())
    if (existsSync(real)) copyFileSync(real, env.GIT_INDEX_FILE)
    const index = await g(['write-tree'], env).then(t => t.trim(), e => { if (e.killed) throw e; return null }) // null while conflicted
    // Seed from the staged tree so tracked files that match .gitignore are kept.
    await g(['read-tree', index ?? head], env)
    await g(['add', '-A', '--', '.'], env)
    const tree = (await g(['write-tree'], env)).trim()
    return { head, index, tree }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// The whole snapshot within GIT_TIMEOUT, else null: a killed git's child (an LFS filter, a hook) holding its output
// open keeps the call from returning. What a send or a turn's end waits on (lib/agent.js).
// ponytail: the late snapshot runs on unheard; its git calls are still killed, the child lives until it ends.
export function snapshotWithin(cwd) {
  let timer
  return Promise.race([snapshot(cwd), new Promise(r => { timer = setTimeout(r, GIT_TIMEOUT, null) })]).finally(() => clearTimeout(timer))
}

// A merge/rebase/cherry-pick in progress: don't checkpoint, its state can't be captured faithfully.
export async function busy(cwd) {
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (await git(cwd, ['rev-parse', '-q', '--verify', ref]).then(() => true, () => false)) return ref
  }
  for (const d of ['rebase-merge', 'rebase-apply']) {
    if (existsSync(resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', d])).trim()))) return d
  }
  return (await git(cwd, ['ls-files', '-u'])).trim() ? 'conflicts' : null
}

// If the worktree lost its checkout, git would resolve an ancestor repo (a git-tracked $HOME…)
// and a restore would wipe it. Only ever operate on a directory that is its own worktree root.
async function ensureRoot(cwd) {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']).then(t => realpathSync(t.trim()), () => null)
  if (top !== realpathSync(cwd)) throw new Error(`${cwd} is not the root of a git worktree.`)
}

// Keep a checkpoint alive (git gc would drop an unreferenced tree) under a private ref.
export const ID = { GIT_AUTHOR_NAME: 'aiguillage', GIT_AUTHOR_EMAIL: 'aiguillage@localhost', GIT_COMMITTER_NAME: 'aiguillage', GIT_COMMITTER_EMAIL: 'aiguillage@localhost' }
export async function pin(cwd, ref, { head, tree }) {
  const c = (await git(cwd, ['commit-tree', tree, '-p', head, '-m', 'aiguillage checkpoint'], ID)).trim()
  await git(cwd, ['update-ref', ref, c])
}

// Only files that differ from the checkpoint are rewritten (mtimes of the rest stay put,
// so dev-server watchers don't fire for nothing). Ignored files are never touched.
export async function restore(cwd, { head, index, tree }) {
  await ensureRoot(cwd)
  const cur = await git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']).then(t => t.trim(), () => null)
  if (cur !== head || await busy(cwd)) await git(cwd, ['reset', '-q', '--mixed', head]) // also clears merge state
  await git(cwd, ['read-tree', '--reset', head])
  await git(cwd, ['add', '-A', '--', '.'])          // index = current working copy, fresh stat info
  await git(cwd, ['read-tree', '--reset', '-u', tree]) // update only what differs
  await git(cwd, ['clean', '-fdq'])                  // drop untracked files the checkpoint didn't have
  await git(cwd, ['read-tree', '--reset', index ?? head]) // staged state as it was
  await git(cwd, ['update-index', '-q', '--refresh']).catch(() => {})
}

export async function dropRefs(repo, prefix) {
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(Boolean)
  for (const r of refs) await git(repo, ['update-ref', '-d', r])
}
