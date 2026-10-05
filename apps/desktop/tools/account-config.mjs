// Writes resources/account-config.json from apps/shared/Config/<env>.plist: the Clerk publishable
// key and the cloud URL the build talks to. The environment is the argument, else CODYNC_ENV,
// else dev. Usage: node tools/account-config.mjs [dev|main]
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.argv[2] ?? process.env.CODYNC_ENV ?? 'dev'
if (!['dev', 'main'].includes(env)) throw new Error(`unknown environment ${env}`)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plist = readFileSync(join(root, '../shared/Config', `${env}.plist`), 'utf8')
const value = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null
writeFileSync(
  join(root, 'resources/account-config.json'),
  `${JSON.stringify({ environment: env, clerkPublishableKey: value('clerkPublishableKey'), cloudURL: value('cloudURL') }, null, 2)}\n`,
)
console.log(`account config: ${env}`)
