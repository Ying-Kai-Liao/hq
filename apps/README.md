# Apps

## Usage analytics key (PostHog)

The iOS app sends usage analytics to our PostHog project (US cloud, `https://us.i.posthog.com`).
The project key is not in the source. It is read at runtime from a `Secrets.plist` that the
build copies into the app (the "Codync environment" build phase in `project.yml`).

For a local build that reports analytics:

```sh
cp apps/shared/Config/Secrets.example.plist apps/shared/Config/Secrets.plist
# put the project key in the POSTHOG_API_KEY string
```

On Kai's Mac the key sits in `~/.hq/secrets/posthog-key`; `sh apps/tools/write-secrets.sh`
writes `Secrets.plist` from it (run it before building; it never prints the key).

`Secrets.plist` is gitignored. Without it (CI, forks) or with an empty value, analytics does
nothing: no events are queued and no requests are made. The "Share usage analytics" setting
still shows.

The desktop app sends nothing to PostHog itself; it goes through the host, which holds its own key.
