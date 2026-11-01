// Desktop app self-update from GitHub releases.
// The .app isn't Apple-signed, so Squirrel.Mac (Electron's autoUpdater, electron-updater) refuses to install.
// Same flow as theirs, by hand: check the latest release, download its .zip in the background,
// check it against GitHub's SHA-256 digest, then swap the bundle once the app has quit and reopen it.
// ponytail: once the app is signed + notarized, Electron's autoUpdater with update.electronjs.org can replace this.
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, accessSync, constants, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'

// Overridable to try an update against a local feed.
const FEED = process.env.AIGUILLAGE_UPDATE_FEED || 'https://api.github.com/repos/xeewi/aiguillage/releases/latest'
const EVERY = 4 * 3600_000 // GitHub allows 60 anonymous API calls per hour; this makes 6 a day

// 'v1.10.0' > '1.9.2'. Pre-release suffixes are ignored: /releases/latest never returns pre-releases.
export function newer(a, b) {
  const p = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n) || 0)
  const x = p(a), y = p(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
// electron-builder names them Aiguillage-1.2.0-arm64-mac.zip (Apple silicon) and Aiguillage-1.2.0-mac.zip (Intel).
export const pickZip = (assets = [], arch = process.arch) =>
  assets.find(a => a.name.endsWith('-mac.zip') && a.name.includes('-arm64-') === (arch === 'arm64'))

// state: off (browser mode, dev) | idle | checking | downloading | ready (restart to install) | manual (download it yourself) | error
let status = { state: 'off' }, electron, hooks, staged, installing = false
const set = s => { status = { ...status, ...s }; hooks?.changed() }
export const info = () => status
export const busy = () => hooks?.busy() ?? 0 // agents mid-turn: a restart interrupts them

const bundle = () => resolve(process.execPath, '../../..') // …/Aiguillage.app/Contents/MacOS/Aiguillage
const dir = () => join(electron.app.getPath('userData'), 'update')
// Run from the .dmg, from Downloads (App Translocation) or from a folder we can't write to: we can't swap it.
function canSwap() {
  const b = bundle()
  if (!b.endsWith('.app') || b.startsWith('/Volumes/') || b.includes('/AppTranslocation/')) return false
  try { accessSync(dirname(b), constants.W_OK); return true } catch { return false }
}

// hooks: { changed, enabled() → bool, busy() → agents working, beforeInstall() }
export async function start(h) {
  electron = await import('electron'); hooks = h
  if (!electron.app.isPackaged) return
  // The swap helper leaves this behind when it couldn't replace the app: offer the download instead next time.
  const failed = existsSync(join(dir(), 'failed'))
  rmSync(dir(), { recursive: true, force: true })
  set({ state: 'idle', version: electron.app.getVersion(), failed })
  setTimeout(check, 15_000)
  setInterval(check, EVERY).unref()
}

export async function check(manual = false) {
  if (status.state === 'off' || ['checking', 'downloading', 'ready'].includes(status.state)) return status
  if (!manual && !hooks.enabled()) return status
  set({ state: 'checking', error: null })
  try {
    const r = await fetch(FEED, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`)
    const rel = await r.json()
    if (!newer(rel.tag_name, status.version)) return set({ state: 'idle' }), status
    const latest = { latest: rel.tag_name.replace(/^v/, ''), url: rel.html_url }
    const zip = pickZip(rel.assets)
    if (!zip?.digest?.startsWith('sha256:') || !canSwap() || status.failed) return set({ state: 'manual', ...latest }), status
    set({ state: 'downloading', ...latest })
    staged = await download(zip)
    set({ state: 'ready' })
  } catch (e) {
    console.error('[aiguillage] update:', e.message)
    set({ state: 'error', error: e.message }) // silent in the UI; the next check retries
  }
  return status
}

async function download(asset) {
  const d = dir()
  rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true })
  const r = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!r.ok) throw new Error(`download: HTTP ${r.status}`)
  const hash = createHash('sha256'), zip = join(d, asset.name)
  await pipeline(Readable.fromWeb(r.body), async function* (src) { for await (const c of src) { hash.update(c); yield c } }, createWriteStream(zip))
  if ('sha256:' + hash.digest('hex') !== asset.digest) throw new Error('download: checksum mismatch')
  await promisify(execFile)('ditto', ['-x', '-k', zip, d]) // ditto keeps the framework symlinks intact
  const app = join(d, basename(bundle()))
  if (!existsSync(join(app, 'Contents/MacOS'))) throw new Error('download: no app in the archive')
  rmSync(zip)
  return app
}

// Waits for this process to exit, swaps the bundles (rename: same volume, so atomic), rolls back on failure.
const SWAP = `
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
old="$3.old-$$"
if mv "$3" "$old" && mv "$2" "$3"; then rm -rf "$old" "$4"; xattr -dr com.apple.quarantine "$3" 2>/dev/null
else [ -e "$old" ] && [ ! -e "$3" ] && mv "$old" "$3"; touch "$4/failed"; fi
[ "$5" = 1 ] && open "$3"
exit 0`

// relaunch=false: the user quit with an update ready; it's installed on the way out (like electron-updater's autoInstallOnAppQuit).
export function install(relaunch = true) {
  if (status.state !== 'ready' || installing) return
  installing = true
  if (relaunch) hooks.beforeInstall()
  spawn('/bin/sh', ['-c', SWAP, 'swap', String(process.pid), staged, bundle(), dir(), relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref()
  if (relaunch) electron.app.quit()
}
