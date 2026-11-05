import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export const HOME = process.env.AIGUILLAGE_HOME || join(homedir(), '.aiguillage')
const STATE = join(HOME, 'state.json')
const LOGS = join(HOME, 'logs')
// Plain-text output of the workspace's setup/run script, readable by the agent.
export const runLogPath = id => join(LOGS, id + '.run.log')
export const WORKTREES = join(HOME, 'worktrees')
// Files attached in the chat: kept outside the worktree so they never show up in the diff.
export const ATTACHMENTS = join(HOME, 'attachments')
export const attachDir = id => join(ATTACHMENTS, id)
// An attachment's file name as given (the chat's upload, Telegram's), made safe: no folder, control char or dot file.
export const fileName = name => basename(String(name ?? '')).replace(/[\x00-\x1f\\:]/g, '_').replace(/^\.+/, '').slice(-150) || 'file'
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
export function writeLog(id, evs) {
  writeFileSync(logFile(id) + '.tmp', evs.map(e => JSON.stringify(e) + '\n').join(''))
  renameSync(logFile(id) + '.tmp', logFile(id))
}

export const newId = () => Math.random().toString(36).slice(2, 10)
