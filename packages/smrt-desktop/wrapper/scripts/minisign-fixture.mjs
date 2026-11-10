// Test-only: builds minisign key pairs and signatures in the format Tauri's
// updater uses, from keys generated on the spot. Nothing here is, or derives
// from, a real key; it is imported only by the *.test.mjs files.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64 = (value) => Buffer.from(value).toString('base64');

/** A fresh Ed25519 key pair with a minisign key id and the Tauri pubkey text. */
export function makeKey(keyId = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const body = Buffer.concat([Buffer.from('Ed'), keyId, raw]);
  const file = `untrusted comment: minisign public key: ${Buffer.from(keyId)
    .reverse()
    .toString('hex')
    .toUpperCase()}\n${body.toString('base64')}\n`;
  return { keyId, privateKey, pubkey: b64(file) };
}

/**
 * The content of a `.sig` file for `bytes`. `prehashed: true` is the "ED"
 * variant the Tauri CLI emits, false the legacy "Ed" variant.
 */
export function signBytes(key, bytes, options = {}) {
  const {
    prehashed = true,
    trustedComment = 'timestamp:1794213803\tfile:payload.bin',
    untrustedComment = 'signature from tauri secret key',
    keyId = key.keyId,
  } = options;
  const message = prehashed
    ? createHash('blake2b512').update(bytes).digest()
    : Buffer.from(bytes);
  const signature = sign(null, message, key.privateKey);
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment)]),
    key.privateKey,
  );
  const body = Buffer.concat([
    Buffer.from(prehashed ? 'ED' : 'Ed'),
    keyId,
    signature,
  ]);
  return b64(
    `untrusted comment: ${untrustedComment}\n${body.toString('base64')}\n` +
      `trusted comment: ${trustedComment}\n${global.toString('base64')}\n`,
  );
}
