import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ALL_SECTIONS, botSections } from './bot-sections.ts'
import { parseKithInfo } from './kith-info.ts'

const house = parseKithInfo(JSON.parse(readFileSync(new URL('./test-support/kith-house-info.json', import.meta.url), 'utf8')))!

test('an hq bot with Kith details hides the cards Kith repeats', () => {
  assert.deepEqual(botSections('house', house), {
    instructions: false, backendPicker: false, harnessMemoryTab: false,
  })
})

test('a plain bot keeps every card, whatever Kith says', () => {
  assert.deepEqual(botSections(null, house), ALL_SECTIONS)
  assert.deepEqual(botSections(undefined, house), ALL_SECTIONS)
})

test('an hq bot keeps every card until Kith details are on screen, except the harness notes tab', () => {
  assert.deepEqual(botSections('house', null), { ...ALL_SECTIONS, harnessMemoryTab: false })
})

test('a card stays when Kith could not read what it repeats', () => {
  const partial = { ...house, harness: null, errors: { role: 'unreadable' } }
  assert.deepEqual(botSections('house', partial), {
    instructions: true, backendPicker: true, harnessMemoryTab: false,
  })
})
