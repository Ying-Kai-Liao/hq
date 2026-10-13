import assert from 'node:assert/strict'
import test from 'node:test'
import type { UpdateState } from './ipc.ts'
import { updateControl, updateMenuEnabled, updateMenuLabel } from './update-control.ts'

function state(partial: Partial<UpdateState>): UpdateState {
  return {
    supported: true,
    checking: false,
    availableVersion: null,
    staged: false,
    autoCheck: true,
    autoDownload: true,
    lastCheck: null,
    error: null,
    waitingForApp: null,
    downloadPercent: null,
    ...partial,
  }
}

test('an idle app offers a check', () => {
  assert.deepEqual(updateControl(state({})), { kind: 'check' })
  assert.equal(updateMenuLabel(state({})), 'Check for Updates…')
  assert.equal(updateMenuEnabled(state({})), true)
})

test('a found release offers install until the download starts', () => {
  const found = state({ availableVersion: '2.16.0' })
  assert.deepEqual(updateControl(found), { kind: 'install', version: '2.16.0' })
  assert.equal(updateMenuLabel(found), 'Update to 2.16.0…')
})

test('download percent replaces the action and the menu item cannot be clicked', () => {
  const downloading = state({ availableVersion: '2.16.0', downloadPercent: 42 })
  assert.deepEqual(updateControl(downloading), { kind: 'progress', percent: 42 })
  assert.equal(updateMenuLabel(downloading), 'Downloading 42%…')
  assert.equal(updateMenuEnabled(downloading), false)
})

test('a finished download asks for restart only when automatic install is off', () => {
  const manual = state({ availableVersion: '2.16.0', staged: true, autoDownload: false })
  assert.deepEqual(updateControl(manual), { kind: 'restart' })
  assert.equal(updateMenuLabel(manual), 'Restart to Update…')
  assert.equal(updateMenuEnabled(manual), true)
  const automatic = state({ availableVersion: '2.16.0', staged: true, autoDownload: true })
  assert.deepEqual(updateControl(automatic), { kind: 'install', version: '2.16.0' })
})

test('a development build can still restart a release that is already staged', () => {
  const staged = state({ supported: false, staged: true, autoDownload: false, availableVersion: '2.16.0' })
  assert.equal(updateMenuEnabled(staged), true)
  assert.equal(updateMenuEnabled(state({ supported: false })), false)
})
