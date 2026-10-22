// Writes resources/account-config.json from apps/shared/Config/<env>.plist: the Clerk publishable
// key and the cloud URL the build talks to. Usage: node tools/account-config.mjs dev|main
// (the `npm run dev` / `dist:*:<env>` scripts run it). KITH_CLERK_PUBLISHABLE_KEY / KITH_CLOUD_URL
// (or the older CODYNC_* names) in the environment win over the plist, so a release build can be
// given the key without committing it; unset or empty keeps the plist (empty = accounts off).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.argv[2]
if (!['dev', 'main'].includes(env)) throw new Error(`unknown environment ${env}`)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plist = readFileSync(join(root, '../shared/Config', `${env}.plist`), 'utf8')
const value = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null
const fromEnv = (...names) => names.map((n) => process.env[n]?.trim()).find(Boolean)
const clerkPublishableKey = fromEnv('KITH_CLERK_PUBLISHABLE_KEY', 'CODYNC_CLERK_PUBLISHABLE_KEY') ?? value('clerkPublishableKey')
const cloudURL = fromEnv('KITH_CLOUD_URL', 'CODYNC_CLOUD_URL') ?? value('cloudURL')
writeFileSync(
  join(root, 'resources/account-config.json'),
  `${JSON.stringify({ environment: env, clerkPublishableKey, cloudURL }, null, 2)}\n`,
)
console.log(`account config: ${env}`)
