import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSettingsPage, resolveSettingsPage, SETTINGS_PAGES } from './settings-pages.ts'

test('computers is still a settings page and opens Account', () => {
  assert.equal(isSettingsPage('computers'), true)
  assert.equal(resolveSettingsPage('computers'), 'account')
})

test('every other page resolves to itself', () => {
  for (const page of SETTINGS_PAGES.filter((p) => p !== 'computers')) assert.equal(resolveSettingsPage(page), page)
})
