import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRendererURL, isSafeExternalURL } from './navigation.ts'

test('only http, https and mailto links leave the app', () => {
  for (const ok of ['https://a.com', 'http://a.com/x', 'mailto:a@b.c', ' HTTPS://A.COM']) assert.ok(isSafeExternalURL(ok), ok)
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'x-apple.systempreferences:x', 'kith://x', '']) assert.ok(!isSafeExternalURL(bad), bad)
})

test('the dev server is matched by origin', () => {
  const base = 'http://localhost:5173/?window=chat'
  assert.ok(isRendererURL('http://localhost:5173/?window=settings&page=x', base))
  assert.ok(!isRendererURL('http://localhost:5174/', base))
  assert.ok(!isRendererURL('https://localhost:5173/', base))
  assert.ok(!isRendererURL('http://evil.com/', base))
})

test('a packaged build is matched by its index.html only', () => {
  const base = 'file:///Applications/Kith.app/out/renderer/index.html?window=chat'
  assert.ok(isRendererURL('file:///Applications/Kith.app/out/renderer/index.html?window=island', base))
  assert.ok(!isRendererURL('file:///Users/me/Downloads/x.html', base))
  assert.ok(!isRendererURL('about:blank', base))
  assert.ok(!isRendererURL(undefined, base))
  assert.ok(!isRendererURL('not a url', base))
})
