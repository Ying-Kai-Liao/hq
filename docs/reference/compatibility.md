# Host and app compatibility

Kith's product version (`kith --version`, the desktop app's and the iPhone app's version) is for people:
release notes, tags, the Homebrew formula. No side compares product versions to decide whether it can work
with the other. That is done with **protocol levels**, small integers that change only when the wire does.

Kith's own version line starts at 0.1.0. The builds before it were numbered 2.x (the line Kith was forked
from); they are called legacy hosts below.

## The numbers

| Where | Name | Meaning |
|---|---|---|
| host `hello` | `protocol` | The host's protocol level. |
| host `hello` | `minProtocol` | The oldest client level the host still serves. |
| each client | `PROTOCOL` | The client's own level, checked against the host's `minProtocol`. |
| each client | `MIN_HOST_PROTOCOL` | The oldest host level the client works with. |
| each client | `LEGACY_MIN_HOST` | Toward a legacy host: the oldest 2.x version the client works with (2.12.0). |

They live in `serve/host/src/compat.rs` (host, and the terminal client), `apps/desktop/src/shared/compat.ts`
and `apps/ios/Kit/Sources/KithKit/Models/Compatibility.swift`. All three are at level 1.

## The check

Every client asks `hello` on each (re)connect and decides:

1. `protocol` present:
   - client level below `minProtocol`: **update this app**;
   - `protocol` below the client's `MIN_HOST_PROTOCOL`: **update Kith on the computer**;
   - otherwise they work together.
2. `protocol` absent: a legacy host.
   - version below `LEGACY_MIN_HOST`: **update Kith on the computer**;
   - otherwise they work together. The legacy `minApp` is not read: every client with a protocol level
     is newer than any `minApp` a legacy host names.

An unreadable or missing value never locks anyone out. A client that can't decode what the host sends asks
for an app update only when the host is on a protocol level and its version is newer than the client's
(both on Kith's own line); a legacy host's 2.x says nothing about a 0.x client.

The texts say which side to update and the host's version, never a minimum number.

## Optional features

A feature that only some hosts have hides its control instead of raising a floor. Features that legacy hosts
got late (skills: 2.14.1) are on every host with a protocol level, so clients check
`hostHas(hello, "2.14.1")` / `VersionMismatch.hostHas`: true when `protocol` is present, else by the legacy
version. A feature added from now on raises `PROTOCOL` on the host, and clients gate on the level.

## Changing the wire: the two-release rule

- **Adding** a field or method is free. Record the new shape:
  `KITH_SERVE_UPDATE_WIRE_SHAPE=1 cargo test --test e2e wire_shape` (`serve/host/tests/fixtures/wire-shape.json`).
- **Something clients check for** (a new method, a new event kind): raise the host's `PROTOCOL`; clients gate
  on `protocol >= N`.
- **Removing or retyping** a field older clients read: first ship clients that no longer need it, and once
  they are out, raise `MIN_PROTOCOL` in the same change that removes it, then re-record the shape. The
  `wire_shape_matches_the_snapshot` test refuses a removal while `minProtocol` is unchanged.
- **A client dropping support for old hosts**: raise its `MIN_HOST_PROTOCOL`.

## Host updates and paired iPhones

`kith-serve update` reads the new release's `minProtocol` (from its compat file, or `kith-serve compat` on
the downloaded binary). A release that raises it, on a computer with paired iPhones, waits in
`waitingForApp`; nothing can tell when the iPhones have a newer app (Kith's iPhone app is not in the App
Store), so the owner updates the app and runs `kith-serve update --skip-app-check`. A release that keeps
`minProtocol` installs as usual. This build has no release channel, so the gate is dormant.

## Relay labels

Account computers listed by the cloud have no `hello` yet, only the version the host registered.
`LabelFamily.forHost` (iOS) gives a 2.x version below 2.20.0 (and no version) the legacy relay labels and
every other version, 0.x included, the `kith/*` ones. Hosts accept both families.

## Apps built before 0.1.0

Desktop and iPhone builds from the 2.x line compare product versions: they ask to update the computer when
it runs 0.1.0. Rebuild them from this version or later.
