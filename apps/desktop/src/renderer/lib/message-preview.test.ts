import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messagePreview } from './message-preview.ts'

test('roster previews read formatted replies without markdown markers', () => {
  assert.equal(messagePreview('算好了：**123 × 45 = 5,535** ✅\nDetails'), '算好了：123 × 45 = 5,535 ✅')
  assert.equal(messagePreview('\n  > **Ready**: `my_file.ts`\r\nMore'), 'Ready: my_file.ts')
  assert.equal(messagePreview('### Release notes'), 'Release notes')
  assert.equal(messagePreview('  \n\t'), '')
  assert.equal(messagePreview('2 * 3 = 6; my_file.ts'), '2 * 3 = 6; my_file.ts')
})
