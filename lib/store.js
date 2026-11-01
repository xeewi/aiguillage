import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const HOME = process.env.AIGUILLAGE_HOME || join(homedir(), '.aiguillage')
const STATE = join(HOME, 'state.json')
const LOGS = join(HOME, 'logs')
// Plain-text output of the workspace's setup/run script, readable by the agent.
export const runLogPath = id => join(LOGS, id + '.run.log')
export const WORKTREES = join(HOME, 'worktrees')
mkdirSync(LOGS, { recursive: true })

export const state = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : { repos: [], workspaces: [] }

// ponytail: whole-file rewrite on each change; fine for hundreds of workspaces.
export function save() {
  writeFileSync(STATE + '.tmp', JSON.stringify(state, null, 2))
  renameSync(STATE + '.tmp', STATE)
}

const logFile = id => join(LOGS, id + '.jsonl')
export const appendLog = (id, ev) => appendFileSync(logFile(id), JSON.stringify(ev) + '\n')
export function readLog(id) {
  if (!existsSync(logFile(id))) return []
  // A line half-written during a crash must not cost the whole conversation.
  return readFileSync(logFile(id), 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
}
export const writeLog = (id, evs) => writeFileSync(logFile(id), evs.map(e => JSON.stringify(e) + '\n').join(''))

export const newId = () => Math.random().toString(36).slice(2, 10)
