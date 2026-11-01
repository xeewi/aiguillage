// The pure parts of lib/update.js: version order and which release asset this Mac downloads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newer, pickZip, info } from '../lib/update.js'

test('newer compares versions numerically, tag prefix and pre-release suffix aside', () => {
  assert.equal(newer('v0.2.0', '0.1.0'), true)
  assert.equal(newer('v1.10.0', '1.9.9'), true)
  assert.equal(newer('v0.1.0', '0.1.0'), false)
  assert.equal(newer('v0.1.0', '0.2.0'), false)
  assert.equal(newer('v1.0', '1.0.0'), false)
  assert.equal(newer('v1.0.1-beta', '1.0.0'), true)
})

test('pickZip takes the .zip for this architecture, never the .dmg', () => {
  const assets = ['Aiguillage-0.2.0-arm64.dmg', 'Aiguillage-0.2.0-arm64-mac.zip', 'Aiguillage-0.2.0-mac.zip', 'Aiguillage-0.2.0-arm64-mac.zip.blockmap'].map(name => ({ name }))
  assert.equal(pickZip(assets, 'arm64').name, 'Aiguillage-0.2.0-arm64-mac.zip')
  assert.equal(pickZip(assets, 'x64').name, 'Aiguillage-0.2.0-mac.zip')
  assert.equal(pickZip(assets.slice(0, 2), 'x64'), undefined)
})

test('outside the desktop app the updater stays off', () => {
  assert.equal(info().state, 'off')
})
