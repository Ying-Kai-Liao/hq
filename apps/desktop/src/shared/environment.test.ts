import assert from 'node:assert/strict'
import { test } from 'node:test'
import { environmentProfile, hostEnvironmentError } from './environment.ts'

test('development installations cannot share production resources or update feed', () => {
  const prod = environmentProfile('main')
  const dev = environmentProfile('dev')
  assert.equal(prod.appId, 'com.pokai.Codync')
  assert.equal(prod.port, 19225)
  assert.equal(prod.dataFolder, '.kith/serve-main')
  assert.equal(prod.hostLabel, 'dev.kith.serve.main')
  assert.equal(prod.supervisor, 'kith-servew-main.exe')
  for (const key of Object.keys(prod) as (keyof typeof prod)[]) assert.notEqual(dev[key], prod[key], key)
  assert.equal(dev.releaseUpdates, false)
})

test('the development app installs as Kith Dev', () => {
  const dev = environmentProfile('dev')
  assert.equal(dev.name, 'Kith Dev')
  assert.equal(dev.appId, 'com.yingkailiao.kith.dev')
  assert.equal(dev.dataFolder, '.kith/serve')
  assert.equal(dev.port, 19224)
  assert.equal(dev.hostLabel, 'dev.kith.serve')
  assert.equal(dev.systemdUnit, 'kith-serve.service')
  assert.equal(dev.screenLabel, 'com.yingkailiao.kith.dev.screen')
})

test('a development app rejects production and old unidentified hosts', () => {
  assert.equal(hostEnvironmentError('main', undefined), null)
  assert.equal(hostEnvironmentError('main', 'main'), null)
  assert.equal(hostEnvironmentError('dev', 'dev'), null)
  assert.ok(hostEnvironmentError('dev', undefined))
  assert.ok(hostEnvironmentError('dev', 'main'))
  assert.ok(hostEnvironmentError('main', 'dev'))
})
