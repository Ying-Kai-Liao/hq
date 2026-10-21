# Apps

## Usage analytics key (PostHog)

The iOS app sends usage analytics to our PostHog project (US cloud, `https://us.i.posthog.com`).
The project key is a public, write-only PostHog key and is built in as the default
(`Analytics.defaultKey`), so every build reports analytics unless the user turns off
"Share usage analytics" in Settings.

To override it for a local build, put another key in a gitignored `Secrets.plist` that the
build copies into the app (the "Codync environment" build phase in `project.yml`):

```sh
cp apps/shared/Config/Secrets.example.plist apps/shared/Config/Secrets.plist
# put the project key in the POSTHOG_API_KEY string
```

On Kai's Mac the key sits in `~/.hq/secrets/posthog-key`; `sh apps/tools/write-secrets.sh`
writes `Secrets.plist` from it (it never prints the key). An empty or missing value falls back
to the built-in default.

The desktop app sends nothing to PostHog itself; it goes through the host, which holds its own key.

## Host and accounts

The Mac app runs against `kith-serve` (built from `serve/host`): dev data in `~/.kith/serve` on
port 19224, launchd job `dev.kith.serve`; main uses `~/.kith/serve-main`, 19225 and
`dev.kith.serve.main`. If `kith serve start` already installed the job, the app adopts it and never
rewrites its plist. Kith has no accounts: `shared/Config/*.plist` are empty, so Clerk and the
account cloud stay off. The relay URL comes from the host's `config.json` (`relay_url`) and travels
in the pairing link; the apps need no relay setting.

## Installing on your own iPhone (free Personal Team)

The committed `DEVELOPMENT_TEAM` is not yours. Pass your team on the command line (or set it
in Xcode, Signing & Capabilities) and switch the iOS app to the entitlements a free team can
sign (no Push, Sign in with Apple or communication notifications; app groups and the
keychain group are kept):

```sh
xcodebuild build -project apps/Codync.xcodeproj -scheme "iOS Dev" -configuration DevDebug \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<your team id> KITH_PERSONAL_TEAM=YES
```

In Xcode: open `apps/Codync.xcodeproj`, scheme "iOS Dev", pick your phone, set the team on the
three targets, add the user-defined build setting `KITH_PERSONAL_TEAM = YES` to the project,
Run. Then on the iPhone trust the developer: Settings, General, VPN & Device Management.
Profiles from a free team expire after 7 days.
