// node --test scripts/notices/generate.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detect, evalSpdx } from './generate.mjs'

const status = (e) => evalSpdx(e).status

test('permissive licenses pass', () => {
  for (const id of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'Zlib', 'Unicode-3.0', '0BSD', 'CC0-1.0', 'Unlicense', 'BSL-1.0', 'OFL-1.1']) assert.equal(status(id), 'allowed', id)
})

test('copyleft and non-commercial licenses are denied', () => {
  for (const id of ['GPL-3.0-only', 'GPL-2.0+', 'AGPL-3.0', 'SSPL-1.0', 'BUSL-1.1', 'Commons-Clause', 'CC-BY-NC-4.0', 'UNLICENSED']) assert.equal(status(id), 'denied', id)
})

test('LGPL needs a review, unknown ids and a missing license do not pass', () => {
  assert.equal(status('LGPL-2.1-or-later'), 'review')
  assert.equal(status('Made-Up-1.0'), 'unknown')
  assert.equal(status(''), 'unknown')
})

test('OR takes the best branch, AND the worst, WITH keeps the base license', () => {
  assert.deepEqual(evalSpdx('GPL-3.0-only OR MIT'), { status: 'allowed', ids: ['MIT'] })
  assert.equal(status('MIT AND GPL-3.0-only'), 'denied')
  assert.equal(status('(MIT OR Apache-2.0) AND ISC'), 'allowed')
  assert.equal(status('Apache-2.0 WITH LLVM-exception'), 'allowed')
  assert.equal(status('MIT/Apache-2.0'), 'allowed')
  assert.deepEqual(evalSpdx('Apache-2.0 OR MIT').ids, ['MIT'])
})

test('license text is recognised', () => {
  assert.equal(detect('Permission is hereby granted, free of charge, to any person'), 'MIT')
  assert.equal(detect('Apache License\n Version 2.0, January 2004'), 'Apache-2.0')
  assert.equal(detect('GNU GENERAL PUBLIC LICENSE Version 3'), 'GPL-3.0')
})
