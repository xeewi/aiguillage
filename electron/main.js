// Desktop shell: runs the local server in-process and shows it in a native window.
// The web mode (`npm start`) is unchanged; both use port 4317, which doubles as the "one server at a time" lock.
import { app, BrowserWindow, Menu, shell, dialog, nativeTheme } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { i18n } from '../lib/i18n.js'
import * as U from '../lib/update.js'

process.env.PORT ||= '4317'
const BASE = `http://127.0.0.1:${process.env.PORT}`

// Apps opened from the Finder get a bare PATH: borrow the login shell's so `claude`, `git` and `gh` resolve.
process.env.SHELL ||= userInfo().shell || '/bin/zsh'
if (process.platform === 'darwin') try {
  const out = execFileSync(process.env.SHELL, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 5000 })
  const path = out.split('__PATH__').pop().trim()
  if (path) process.env.PATH = path
} catch {} // keep the default PATH; the UI reports a missing `claude` on first send

if (!app.requestSingleInstanceLock()) app.exit(0)

let server = null, url = null

async function serve() {
  // `npm start` already running: share its server instead of fighting over ~/.aiguillage.
  const page = await fetch(BASE).then(r => r.text()).catch(() => '')
  if (page.includes('<title>Aiguillage</title>')) return BASE
  server = await import('../server.js')
  return server.ready
}

// The window comes back where it was (after an update restart too).
const BOUNDS = () => join(app.getPath('userData'), 'window.json')
const bounds = () => { try { return JSON.parse(readFileSync(BOUNDS(), 'utf8')) } catch { return { width: 1440, height: 900 } } }

function open() {
  const win = new BrowserWindow({
    ...bounds(), minWidth: 820, minHeight: 560, show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 24 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111315' : '#ffffff',
  })
  win.once('ready-to-show', () => win.show())
  win.on('close', () => { try { writeFileSync(BOUNDS(), JSON.stringify(win.getNormalBounds())) } catch {} })
  // Links (run port, PR urls) open in the user's browser; the window only ever shows the app.
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(url)) { e.preventDefault(); if (/^https?:/.test(u)) shell.openExternal(u) } })
  win.loadURL(url)
}

// App menu > Check for Updates…, as in every Mac app. Background checks stay silent; this one always answers.
async function checkNow() {
  const lng = app.getLocale(), t = (k, v) => i18n.t(k, { lng, ...v })
  const s = await U.check(true)
  const ask = (message, detail, buttons) => dialog.showMessageBox({ message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 }).then(r => r.response === 0)
  if (s.state === 'ready') {
    const n = U.busy()
    if (await ask(t('update.readyTitle', { version: s.latest }), n ? t('update.busyWarning', { count: n }) : t('update.readyDetail'), [t('update.restart'), t('update.later')])) U.install()
  } else if (s.state === 'manual') {
    if (await ask(t('update.availableTitle', { version: s.latest }), t('update.manualDetail'), [t('update.download'), t('update.later')])) shell.openExternal(s.url)
  } else if (s.state === 'downloading') dialog.showMessageBox({ message: t('update.downloading', { version: s.latest }) })
  else if (s.state === 'error') dialog.showMessageBox({ type: 'warning', message: t('update.failed'), detail: s.error })
  else if (s.state === 'idle') dialog.showMessageBox({ message: t('update.upToDate'), detail: t('update.upToDateDetail', { version: s.version }) })
}

app.whenReady().then(async () => {
  const lng = app.getLocale()
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' }, { label: i18n.t('update.check', { lng }), click: checkNow, enabled: app.isPackaged },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  try { url = await serve() } catch (e) {
    const lng = app.getLocale()
    dialog.showErrorBox(i18n.t('app.startFailed', { lng }), e.code === 'EADDRINUSE' ? i18n.t('app.portInUse', { lng, port: process.env.PORT }) : e.message)
    return app.quit()
  }
  open()
})

// macOS: closing the window keeps the agents running; the Dock icon brings it back.
app.on('activate', () => { if (url && !BrowserWindow.getAllWindows().length) open() })
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) { if (win.isMinimized()) win.restore(); win.focus() } else if (url) open()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
// An update downloaded but not installed yet goes in as the app quits.
app.on('will-quit', () => { U.install(false); server?.shutdown() })
