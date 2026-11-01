import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)

export async function git(cwd, args, env) {
  const { stdout } = await exec('git', args, {
    cwd, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env,
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

export async function removeWorktree(repo, path) {
  if (existsSync(path)) await git(repo, ['worktree', 'remove', '--force', path])
  await git(repo, ['worktree', 'prune'])
}

// Everything the workspace changed vs. where it forked from base: commits, uncommitted edits and new files.
// One call: diff the fork point against a snapshot tree of the working copy.
export async function diff(cwd, base) {
  const mb = (await git(cwd, ['merge-base', 'HEAD', base])).trim()
  const { tree } = await snapshot(cwd)
  return git(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-color', mb, tree])
}

export async function status(cwd) {
  return (await git(cwd, ['status', '--porcelain'])).trim()
}

// Checkpoint = HEAD + staged index + a tree of the full working copy (tracked + untracked, minus ignored),
// written through a throwaway index so the user's real index is never touched.
export async function snapshot(cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'aig-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
    const index = await git(cwd, ['write-tree']).then(t => t.trim(), () => null) // null while conflicted
    // Seed from the staged tree so tracked files that match .gitignore are kept.
    await git(cwd, ['read-tree', index ?? head], env)
    await git(cwd, ['add', '-A', '--', '.'], env)
    const tree = (await git(cwd, ['write-tree'], env)).trim()
    return { head, index, tree }
  } finally { rmSync(dir, { recursive: true, force: true }) }
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
const ID = { GIT_AUTHOR_NAME: 'aiguillage', GIT_AUTHOR_EMAIL: 'aiguillage@localhost', GIT_COMMITTER_NAME: 'aiguillage', GIT_COMMITTER_EMAIL: 'aiguillage@localhost' }
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
