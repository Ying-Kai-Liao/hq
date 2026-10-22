# Shared cryptographic fixtures

Two files carry the same vectors under the two label families: [remote-relay-vectors.kith.json](remote-relay-vectors.kith.json) (`kith/*` labels, `kith-sig-v1`, `Kith-Sig`: what new pairings use) and [remote-relay-vectors.json](remote-relay-vectors.json) (`codync/*`, `codync-sig-v1`, `Codync-Sig`: pairings made before the rename, which keep them until re-paired). Both stay tested. A host verifies a device under either family and answers in the one that verified; the apps keep a label version per pairing (`kith://` links start `kith/*`, a stored pairing without one is `codync/*`).

Each file contains deterministic protocol-v1 vectors for host/device keys, handshake, frame encryption, chunking, SAS, pairing offers, mailbox, request signatures, claims, signed ACL and sealed push.

The private values are fixed **test seeds**, not live credentials. Changing these bytes changes the common contract checked by Rust, Swift and TypeScript.

[remote-relay-vectors.py](remote-relay-vectors.py) prints the JSON to stdout and requires Python 3 plus `cryptography`. To compare without overwriting the checked-in fixture, from the repository root:

```sh
python3 docs/reference/fixtures/remote-relay-vectors.py > /tmp/codync-relay-vectors.json
cmp docs/reference/fixtures/remote-relay-vectors.json /tmp/codync-relay-vectors.json
python3 docs/reference/fixtures/remote-relay-vectors.py kith > /tmp/kith-relay-vectors.json
cmp docs/reference/fixtures/remote-relay-vectors.kith.json /tmp/kith-relay-vectors.json
```

Consumers:

- `host/src/remote/crypto.rs` (`include_str!`, both files)
- `apps/ios/Kit/Tests/CodyncKitTests/RelayVectorsTests.swift`
- `cloud/test/vectors.test.ts` and `cloud/test/relay.test.ts`

When moving or changing a fixture, update those paths and the cloud, iOS Kit (`kit.yml`) and host CI path filters. Run the affected vector tests; a Markdown link check alone cannot validate executable imports. [Protocol reference](../remote-relay.md).
