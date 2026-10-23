# Pre-rename vectors

Pre-rename compatibility: delete this file, `legacy-compat-vectors.json` and their tests after every pairing made before the Kith rename has been re-paired.

[legacy-compat-vectors.json](legacy-compat-vectors.json) holds the same vectors as [remote-relay-vectors.json](remote-relay-vectors.json) under the old label family (`codync/*`, `codync-sig-v1`, `Codync-Sig`). A host verifies a device under either family and answers in the one that verified; the apps keep a label version per pairing, and a stored pairing without one is the old family.

Regenerate and compare, from the repository root:

```sh
python3 docs/reference/fixtures/remote-relay-vectors.py codync > /tmp/legacy-relay-vectors.json
cmp docs/reference/fixtures/legacy-compat-vectors.json /tmp/legacy-relay-vectors.json
```

Consumers: `host/src/remote/crypto.rs` tests, `apps/ios/Kit/Tests/CodyncKitTests/RelayVectorsTests.swift`, `cloud/test/vectors.test.ts`.
