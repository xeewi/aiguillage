// Repo scripts, highest priority first:
//   <repo root>/.aiguillage/settings.local.toml  >  <workspace>/.aiguillage/settings.toml  >  ~/.aiguillage/settings.toml
// Any TOML layer outranks the simpler aiguillage.json.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse } from 'smol-toml'

const read = (p, fn) => { try { return existsSync(p) ? fn(readFileSync(p, 'utf8')) : null } catch { return null } }

// Normalized: { setup, archive, runMode, run: { id: { command, default } }, fileIncludeGlobs }
function normalize(raw) {
  const s = raw?.scripts ?? {}
  const run = {}
  if (typeof s.run === 'string') run.run = { command: s.run, default: true }
  else for (const [id, r] of Object.entries(s.run ?? {})) if (r?.command) run[id] = { command: String(r.command), default: !!r.default }
  return {
    setup: s.setup || undefined, archive: s.archive || undefined,
    runMode: s.run_mode, run,
    fileIncludeGlobs: raw?.file_include_globs,
  }
}

export function config(wsPath, rootPath = wsPath, home = homedir()) {
  const layers = [
    read(join(rootPath, '.aiguillage/settings.local.toml'), parse),
    read(join(wsPath, '.aiguillage/settings.toml'), parse) ?? read(join(rootPath, '.aiguillage/settings.toml'), parse),
    read(join(home, '.aiguillage/settings.toml'), parse),
  ].filter(Boolean)
  if (!layers.length) {
    const json = read(join(wsPath, 'aiguillage.json'), JSON.parse)
    if (json) layers.push(json.scripts ? json : { scripts: json, file_include_globs: json.file_include_globs })
  }
  const out = { run: {} }
  for (const l of layers.map(normalize).reverse()) { // lowest priority first, higher layers overwrite
    for (const k of ['setup', 'archive', 'runMode', 'fileIncludeGlobs']) if (l[k] !== undefined) out[k] = l[k]
    Object.assign(out.run, l.run)
  }
  return out
}

export const defaultRun = cfg => Object.keys(cfg.run).find(id => cfg.run[id].default) ?? Object.keys(cfg.run)[0]
