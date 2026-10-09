// Fail before packaging if a stale account-config.json belongs to the other app variant.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
module.exports = async (context) => {
  const expected = context.packager.appInfo.id === 'com.pokai.Codync.dev' ? 'dev' : 'main'
  const config = JSON.parse(readFileSync(join(context.packager.projectDir, 'resources/account-config.json'), 'utf8'))
  if (config.environment !== expected) throw new Error(`Packaging ${expected} with ${config.environment} account config; run the matching dist script.`)
}
