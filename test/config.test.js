import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { config, defaultRun } from '../lib/config.js'

const dir = () => mkdtempSync(join(tmpdir(), 'cgcfg-'))
const put = (d, f, s) => { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), s) }

test('TOML layers: local > shared > user, run scripts merged by id', () => {
  const root = dir(), ws = dir(), home = dir()
  put(home, '.aiguillage/settings.toml', '[scripts]\nsetup = "user-setup"\n[scripts.run.user]\ncommand = "u"\n')
  put(ws, '.aiguillage/settings.toml', `[scripts]\nsetup = "pnpm i"\nrun_mode = "nonconcurrent"\n
[scripts.run.dev]\ncommand = "pnpm dev"\ndefault = true\n[scripts.run.test]\ncommand = "pnpm test"\n`)
  put(root, '.aiguillage/settings.local.toml', '[scripts.run.test]\ncommand = "pnpm test --watch"\n')
  put(ws, 'aiguillage.json', '{"setup":"ignored when TOML exists"}')
  const c = config(ws, root, home)
  assert.equal(c.setup, 'pnpm i')
  assert.equal(c.runMode, 'nonconcurrent')
  assert.deepEqual(Object.keys(c.run).sort(), ['dev', 'test', 'user'])
  assert.equal(c.run.test.command, 'pnpm test --watch')
  assert.equal(defaultRun(c), 'dev')
})

test('aiguillage.json: flat or under "scripts"', () => {
  const ws = dir(), home = dir()
  put(ws, 'aiguillage.json', '{"scripts":{"setup":"npm i","run":"npm start","run_mode":"nonconcurrent"}}')
  let c = config(ws, ws, home)
  assert.equal(c.setup, 'npm i')
  assert.equal(c.run.run.command, 'npm start')
  assert.equal(c.runMode, 'nonconcurrent')
  put(ws, 'aiguillage.json', '{"setup":"a","run":"b"}')
  c = config(ws, ws, home)
  assert.equal(c.setup, 'a')
  assert.equal(defaultRun(c), 'run')
  assert.equal(defaultRun(config(dir(), undefined, home)), undefined)
})

test('broken TOML is ignored, user-level settings alone work, no config at all is empty', () => {
  const ws = dir(), home = dir()
  put(ws, '.aiguillage/settings.toml', 'this is = = not toml [')
  put(home, '.aiguillage/settings.toml', '[scripts]\nsetup = "from-user"\n[scripts.run.x]\ncommand = "y"\n')
  const c = config(ws, ws, home)
  assert.equal(c.setup, 'from-user')
  assert.equal(c.run.x.command, 'y')
  assert.deepEqual(config(dir(), undefined, dir()), { run: {} })
})

test('no run script configured: guessed from the project files, task runner first, explicit config wins', () => {
  const home = dir()
  const detect = files => { const ws = dir(); for (const [f, s] of Object.entries(files)) put(ws, f, s); const c = config(ws, ws, home); return [Object.keys(c.run), defaultRun(c)] }
  assert.deepEqual(detect({ 'package.json': '{"scripts":{"start":"node s.js","dev":"vite","test":"x"}}', 'pnpm-lock.yaml': '' }),
    [['pnpm run dev', 'pnpm run start'], 'pnpm run dev'])
  assert.deepEqual(detect({ Makefile: 'run-tests:\n\tx\nrun: build\n\tx\nFOO := 1\n', 'Cargo.toml': '' }), [['make run', 'cargo run'], 'make run'])
  assert.deepEqual(detect({ 'go.mod': '' })[0], ['go run .'])
  assert.deepEqual(detect({ 'manage.py': '', 'uv.lock': '' })[0], ['uv run python manage.py runserver $PORT'])
  assert.deepEqual(detect({ 'mix.exs': '{:phoenix, "~> 1.7"}' })[0], ['mix phx.server'])
  assert.deepEqual(detect({ 'pom.xml': '<artifactId>spring-boot-starter</artifactId>' })[0], ['mvn spring-boot:run'])
  assert.deepEqual(detect({ 'App.csproj': '' })[0], ['dotnet run'])
  assert.deepEqual(detect({ Procfile: 'web: gunicorn app:app\n' })[0], ['gunicorn app:app'])
  assert.deepEqual(detect({ 'compose.yaml': '' })[0], ['docker compose up'])
  assert.deepEqual(detect({ 'Cargo.toml': '', 'aiguillage.json': '{"run":"x"}' })[0], ['run'])
  assert.deepEqual(detect({ 'README.md': '' })[0], [])
})

test('file_include_globs and settings.local.toml read from the repo root, not the worktree', () => {
  const root = dir(), ws = dir(), home = dir()
  put(root, '.aiguillage/settings.local.toml', 'file_include_globs = ["certs/*.pem"]\n[scripts]\narchive = "cleanup"\n')
  put(ws, '.aiguillage/settings.local.toml', '[scripts]\narchive = "WRONG: worktree copy"\n')
  const c = config(ws, root, home)
  assert.deepEqual(c.fileIncludeGlobs, ['certs/*.pem'])
  assert.equal(c.archive, 'cleanup')
})
