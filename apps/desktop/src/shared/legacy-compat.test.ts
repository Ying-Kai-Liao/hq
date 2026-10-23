import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateLegacyStorage } from './legacy-compat.ts'

function memoryStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial))
  return new Proxy({} as Storage, {
    ownKeys: () => [...data.keys()],
    getOwnPropertyDescriptor: (_t, k) => (data.has(String(k)) ? { enumerable: true, configurable: true, value: data.get(String(k)) } : undefined),
    get: (_t, k) => {
      if (k === 'getItem') return (key: string) => data.get(key) ?? null
      if (k === 'setItem') return (key: string, v: string) => void data.set(key, v)
      if (k === 'removeItem') return (key: string) => void data.delete(key)
      return data.get(String(k))
    },
  })
}

test('old draft and mirror keys move to the kith names, keeping a value already there', () => {
  const store = memoryStorage({ 'codync-drafts-v1-[1,2]': 'd', 'codync-mirror-a-b': 'm', 'kith-mirror-a-b': 'new', other: 'x' })
  migrateLegacyStorage(store)
  assert.equal(store.getItem('kith-drafts-v1-[1,2]'), 'd')
  assert.equal(store.getItem('kith-mirror-a-b'), 'new')
  assert.equal(store.getItem('codync-drafts-v1-[1,2]'), null)
  assert.equal(store.getItem('codync-mirror-a-b'), null)
  assert.equal(store.getItem('other'), 'x')
})
