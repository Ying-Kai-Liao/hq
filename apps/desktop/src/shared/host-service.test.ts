import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isKithServeService } from './host-service.ts'

const plist = (extra = '') => `<plist><dict><key>ProgramArguments</key><array><string>/x/kith-serve</string></array>${extra}</dict></plist>`

test("a service with HQ_BIN is kith serve's, wherever its program is", () => {
  assert.equal(isKithServeService(plist('<key>HQ_BIN</key><string>/b/hq</string>'), '/x/kith-serve', '/Users/me', '.kith/serve'), true)
})

test("a service running the binary kith serve installs is kith serve's", () => {
  assert.equal(isKithServeService(plist(), '/Users/me/.kith/serve/bin/kith-serve', '/Users/me', '.kith/serve'), true)
})

test("the app's own bundled service is not", () => {
  assert.equal(isKithServeService(plist(), '/Applications/Kith Dev.app/Contents/Resources/kith-serve', '/Users/me', '.kith/serve'), false)
  assert.equal(isKithServeService(plist(), null, '/Users/me', '.kith/serve'), false)
})
