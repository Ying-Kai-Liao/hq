import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ALL_SECTIONS, botSections, callModelLabel, hqSettings, permissionLabel } from './bot-sections.ts'
import { parseKithInfo } from './kith-info.ts'

const house = parseKithInfo(JSON.parse(readFileSync(new URL('./test-support/kith-house-info.json', import.meta.url), 'utf8')))!

test('an hq bot with Kith details hides the cards Kith repeats', () => {
  assert.deepEqual(botSections('house', house), {
    instructions: false, backendPicker: false, harnessMemoryTab: false, kithSettings: false,
  })
})

test('a plain bot keeps every card, whatever Kith says', () => {
  assert.deepEqual(botSections(null, house), ALL_SECTIONS)
  assert.deepEqual(botSections(undefined, house), ALL_SECTIONS)
})

test('an hq bot keeps every card until Kith details are on screen, except the harness notes tab', () => {
  assert.deepEqual(botSections('house', null), { ...ALL_SECTIONS, harnessMemoryTab: false, kithSettings: false })
})

test('a card stays when Kith could not read what it repeats', () => {
  const partial = { ...house, harness: null, errors: { role: 'unreadable' } }
  assert.deepEqual(botSections('house', partial), {
    instructions: true, backendPicker: true, harnessMemoryTab: false, kithSettings: false,
  })
})

test('an hq bot on a host without kithInfo keeps Kith\'s own settings controls', () => {
  assert.equal(botSections('house', null, true).kithSettings, true)
  assert.equal(botSections('house', house, true).kithSettings, true)
  assert.equal(botSections('house', house, false).kithSettings, false)
})

test('hq settings: permission is written through to hq, the rest is read-only "Set in Kith"', () => {
  const rows = hqSettings({ permissionMode: 'plan', callModel: null, model: 'opus', effort: null })
  assert.deepEqual(rows.map((r) => [r.key, r.value, r.editable]), [
    ['permission', 'plan', true], ['callModel', 'default', true], ['model', 'opus', false], ['effort', "Agent's default", false], ['fastMode', 'Off', false],
  ])
  for (const r of rows.filter((r) => !r.editable)) assert.match(r.hint, /^Set in Kith/)
})

test('hq settings: nothing is editable until hq has answered, and no permission set in hq shows the default', () => {
  assert.equal(hqSettings(null)[0].editable, false)
  assert.equal(hqSettings({ permissionMode: null, callModel: 'haiku', model: null, effort: null })[0].value, 'auto')
})

test('hq settings: the call model is written through to hq, and shows hq\'s choice', () => {
  const row = hqSettings({ permissionMode: null, callModel: 'haiku', model: null, effort: null })[1]
  assert.deepEqual([row.key, row.value, row.editable], ['callModel', 'haiku', true])
  assert.equal(callModelLabel('default'), 'Default (sonnet)')
  assert.equal(callModelLabel('own'), "Agent's own model")
  assert.equal(callModelLabel('gpt-x'), 'gpt-x')
})

test('a permission mode shows by its label, an unknown one as it is', () => {
  assert.equal(permissionLabel('bypassPermissions'), 'Bypass permissions')
  assert.equal(permissionLabel('somethingNew'), 'somethingNew')
})
