import vectors from '../../../../serve/docs/reference/fixtures/remote-relay-vectors.json'
import { signerFromSeed, type Signer } from '../../src/shared/relay-core/crypto.ts'
import { vectorChecks } from '../../src/shared/relay-core/vectors.ts'

// The relay vectors, run by the page's own JS engine with no Node: the pure-JS @noble signer, and a signer over a
// non-extractable WebCrypto Ed25519 key, which is how the web client holds the identity key.

const ED_PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])

async function webCryptoSigner(seed: Uint8Array): Promise<Signer> {
  const der = new Uint8Array(ED_PKCS8.length + seed.length)
  der.set(ED_PKCS8)
  der.set(seed, ED_PKCS8.length)
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
  if (key.extractable) throw new Error('the WebCrypto key must not be extractable')
  return { publicKey: signerFromSeed(seed).publicKey, sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, m)) }
}

declare global {
  interface Window {
    __vectors?: { done: boolean; results: { name: string; ok: boolean; error?: string }[] }
  }
}

const results: { name: string; ok: boolean; error?: string }[] = []
for (const [label, factory] of [
  ['noble signer', async (seed: Uint8Array) => signerFromSeed(seed)],
  ['WebCrypto signer', webCryptoSigner],
] as const) {
  for (const [name, check] of Object.entries(vectorChecks)) {
    try {
      await check(vectors, factory)
      results.push({ name: `${label}: ${name}`, ok: true })
    } catch (e) {
      results.push({ name: `${label}: ${name}`, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
}
window.__vectors = { done: true, results }
document.getElementById('out')!.textContent = results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` (${r.error})` : ''}`).join('\n')
