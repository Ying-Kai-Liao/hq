// Writes resources/account-config.json from apps/shared/Config/<env>.plist (dev | main):
// the Clerk publishable key and the cloud URL the build talks to. Usage: node tools/account-config.mjs dev
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.argv[2] ?? 'dev'
if (!['dev', 'main'].includes(env)) throw new Error(`unknown environment ${env}`)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plist = readFileSync(join(root, '../shared/Config', `${env}.plist`), 'utf8')
const value = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null
writeFileSync(
  join(root, 'resources/account-config.json'),
  `${JSON.stringify({ environment: env, clerkPublishableKey: value('clerkPublishableKey'), cloudURL: value('cloudURL') }, null, 2)}\n`,
)
console.log(`account config: ${env}`)
