// What a turn left behind, looked at from outside: the facts the report carries besides the agent's own words.
import * as G from './git.js'

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/test/**', '**/tests/**', '**/__tests__/**']

// Test files that differ between a checkpoint tree and the working copy now (untracked included: snapshot adds them).
export async function testFiles(cwd, fromTree, globs) {
  if (!globs.length) return []
  const { tree } = await G.snapshot(cwd)
  const out = await G.git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-only', fromTree, tree, '--', ...globs.map(g => `:(glob)${g}`)])
  return out.split('\n').filter(Boolean)
}

// cp: the checkpoint taken before the turn's message (null: nothing to compare with).
export async function inspect(ws, cp, cfg = {}) {
  if (!cp) return { testsTouched: [] }
  return { testsTouched: await testFiles(ws.path, cp.tree, cfg.testGlobs ?? DEFAULT_TEST_GLOBS) }
}
