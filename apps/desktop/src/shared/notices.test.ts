import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseNotices } from './notices.ts'

test('parses the groups, packages and license texts of the notices file', () => {
  const n = parseNotices(
    ['# Third-party notices', '', '<!-- Generated -->', '', 'Intro line.', '', '## MIT', '', '- foo 1.0.0 (npm)', '  https://example.com/foo', '  Copyright (c) A', '- bar 2.0.0 (cargo)', '', '~~~~~', '## not a heading', 'Permission is hereby granted', '~~~~~', '', '## ISC', '', '- baz 3 (npm)'].join('\n'),
  )
  assert.equal(n.intro, 'Intro line.')
  assert.deepEqual(n.groups.map((g) => g.license), ['MIT', 'ISC'])
  assert.deepEqual(n.groups[0].packages, [
    { name: 'foo 1.0.0 (npm)', details: ['https://example.com/foo', 'Copyright (c) A'] },
    { name: 'bar 2.0.0 (cargo)', details: [] },
  ])
  assert.deepEqual(n.groups[0].texts, ['## not a heading\nPermission is hereby granted'])
  assert.equal(n.groups[1].packages.length, 1)
})

test('the checked-in THIRD_PARTY_NOTICES.md parses and names the Codync attribution', () => {
  const n = parseNotices(readFileSync(fileURLToPath(new URL('../../../../THIRD_PARTY_NOTICES.md', import.meta.url)), 'utf8'))
  assert.match(n.intro, /Apache-2\.0/)
  assert.ok(n.groups.length > 3)
  for (const g of n.groups) assert.ok(g.packages.length > 0 && g.texts.length > 0, g.license)
})
