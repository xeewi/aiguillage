// Repo scripts, highest priority first:
//   <repo root>/.aiguillage/settings.local.toml  >  <workspace>/.aiguillage/settings.toml  >  ~/.aiguillage/settings.toml
// Any TOML layer outranks the simpler aiguillage.json.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse } from 'smol-toml'

const read = (p, fn) => { try { return existsSync(p) ? fn(readFileSync(p, 'utf8')) : null } catch { return null } }

// Normalized: { setup, archive, check, runMode, run: { id: { command, default } }, fileIncludeGlobs, testGlobs }
function normalize(raw) {
  const s = raw?.scripts ?? {}
  const run = {}
  if (typeof s.run === 'string') run.run = { command: s.run, default: true }
  else for (const [id, r] of Object.entries(s.run ?? {})) if (r?.command) run[id] = { command: String(r.command), default: !!r.default }
  return {
    setup: s.setup || undefined, archive: s.archive || undefined, check: s.check || undefined,
    runMode: s.run_mode, run,
    fileIncludeGlobs: raw?.file_include_globs,
    testGlobs: Array.isArray(raw?.test_globs) ? raw.test_globs.map(String) : undefined,
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
    for (const k of ['setup', 'archive', 'check', 'runMode', 'fileIncludeGlobs', 'testGlobs']) if (l[k] !== undefined) out[k] = l[k]
    Object.assign(out.run, l.run)
  }
  if (!Object.keys(out.run).length) Object.assign(out.run, detectRun(wsPath))
  return out
}

// No run script configured: guess from the files at the workspace root. Every match is offered (the id is the
// command itself); the project's own task runner comes first, then language conventions.
// PORT is exported to scripts, so most dev servers land on the workspace port.
// ponytail: a lookup table of common layouts, not a universal oracle; anything exotic still needs settings.toml.
const NAMES = ['dev', 'start', 'run', 'serve']
function detectRun(d) {
  const has = f => existsSync(join(d, f))
  const text = f => read(join(d, f), s => s) ?? ''
  const json = f => read(join(d, f), JSON.parse) ?? {}
  const targets = src => NAMES.filter(n => new RegExp(`^${n}(\\s[^:\\n=]*)?:(?!=)`, 'm').test(src)) // make/just recipes
  const py = has('uv.lock') ? 'uv run python' : has('poetry.lock') ? 'poetry run python' : 'python3'
  const files = (() => { try { return readdirSync(d) } catch { return [] } })()
  const out = []
  const add = cmd => cmd && !out.includes(cmd) && out.push(cmd)

  for (const t of targets(text('Makefile'))) add(`make ${t}`)
  for (const t of targets(text('justfile') || text('Justfile'))) add(`just ${t}`)
  const pm = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']].find(([f]) => has(f))?.[1] ?? 'npm'
  const pkg = json('package.json').scripts ?? {}
  for (const n of NAMES) if (typeof pkg[n] === 'string') add(`${pm} run ${n}`)
  const deno = json('deno.json').tasks ?? {}
  for (const n of NAMES) if (deno[n]) add(`deno task ${n}`)
  add(text('Procfile').match(/^web:\s*(.+)$/m)?.[1].trim())
  if (has('Cargo.toml')) add('cargo run')
  if (has('go.mod')) add('go run .')
  if (has('manage.py')) add(`${py} manage.py runserver $PORT`)
  for (const f of ['main.py', 'app.py']) if (has(f)) add(`${py} ${f}`)
  if (has('bin/rails')) add('bin/rails server -p $PORT')
  if (has('mix.exs')) add(text('mix.exs').includes(':phoenix') ? 'mix phx.server' : 'mix run --no-halt')
  if (has('Package.swift')) add('swift run')
  if (has('gradlew')) add(/spring-boot/.test(text('build.gradle') + text('build.gradle.kts')) ? './gradlew bootRun' : './gradlew run')
  if (has('pom.xml')) add(text('pom.xml').includes('spring-boot') ? 'mvn spring-boot:run' : 'mvn compile exec:java')
  if (files.some(f => /\.(csproj|fsproj|sln)$/.test(f))) add('dotnet run')
  if (['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].some(has)) add('docker compose up')

  return Object.fromEntries(out.map((command, i) => [command, { command, default: i === 0 }]))
}

export const defaultRun = cfg => Object.keys(cfg.run).find(id => cfg.run[id].default) ?? Object.keys(cfg.run)[0]
