// Verification of Tauri updater signatures (minisign) with Node's crypto.
//
// A Tauri `.sig` file, and the `signature` field of the updater feed, is the
// base64 of a four line minisign signature file:
//
//   untrusted comment: <text>
//   base64( alg[2] | keyId[8] | ed25519 signature[64] )
//   trusted comment: <text>
//   base64( ed25519 global signature[64] )
//
// `alg` is "ED" (prehashed: the signature covers BLAKE2b-512 of the file, what
// the Tauri CLI emits) or "Ed" (legacy: the signature covers the file bytes).
// The global signature covers the 64 signature bytes followed by the trusted
// comment text, which binds the comment to the signature.
//
// The committed `plugins.updater.pubkey` is the base64 of a two line public key
// file: `untrusted comment: ...` then base64( "Ed" | keyId[8] | key[32] ).
//
// Verifying a signature against the committed public key is the only check in
// the release that proves the private key held by the signing step is the key
// pair of the one clients are told to trust. Everything is strict: unknown key
// ids, extra lines, extra bytes, non-canonical base64 and CR characters are
// refused. Errors never echo key or signature material. Node built-ins only.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const UNTRUSTED = 'untrusted comment:';
const TRUSTED = 'trusted comment: ';
const MAX_TEXT_BYTES = 8192;
const CHUNK = 1024 * 1024;

/** Canonical base64 only: no whitespace, no URL alphabet, exact padding. */
function strictBase64(text, label) {
  if (
    typeof text !== 'string' ||
    text === '' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(text)
  ) {
    throw new Error(`${label} is not base64`);
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) {
    throw new Error(`${label} is not canonical base64`);
  }
  return bytes;
}

/** The text lines of a minisign file; one trailing newline is allowed. */
function fileLines(bytes, expected, label) {
  if (bytes.length === 0 || bytes.length > MAX_TEXT_BYTES) {
    throw new Error(`${label} has an unusable size`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\r') || text.includes('\0')) {
    throw new Error(`${label} has control characters`);
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : null;
  if (lines === null || lines.length !== expected) {
    throw new Error(`${label} is not exactly ${expected} lines`);
  }
  return lines;
}

/** Parse the committed public key. Returns `{ keyId, publicKey }`. */
export function parsePublicKey(pubkey) {
  const lines = fileLines(
    strictBase64(String(pubkey).trim(), 'the public key'),
    2,
    'the public key',
  );
  if (!lines[0].startsWith(UNTRUSTED)) {
    throw new Error('the public key has no untrusted comment line');
  }
  const body = strictBase64(lines[1], 'the public key body');
  if (body.length !== 42 || body.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('the public key is not a minisign Ed25519 key');
  }
  return {
    keyId: body.subarray(2, 10),
    publicKey: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, body.subarray(10, 42)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

/** Parse an updater signature (the content of a `.sig` file). */
export function parseSignature(signature) {
  const lines = fileLines(
    strictBase64(String(signature).trim(), 'the signature'),
    4,
    'the signature',
  );
  if (!lines[0].startsWith(UNTRUSTED)) {
    throw new Error('the signature has no untrusted comment line');
  }
  if (!lines[2].startsWith(TRUSTED)) {
    throw new Error('the signature has no trusted comment line');
  }
  const body = strictBase64(lines[1], 'the signature body');
  const alg = body.subarray(0, 2).toString('latin1');
  if (body.length !== 74 || (alg !== 'ED' && alg !== 'Ed')) {
    throw new Error('the signature is not a minisign Ed25519 signature');
  }
  const global = strictBase64(lines[3], 'the global signature');
  if (global.length !== 64) {
    throw new Error('the global signature has the wrong length');
  }
  return {
    prehashed: alg === 'ED',
    keyId: body.subarray(2, 10),
    signature: body.subarray(10, 74),
    trustedComment: Buffer.from(lines[2].slice(TRUSTED.length), 'utf8'),
    globalSignature: global,
  };
}

/** BLAKE2b-512 of a regular file, read in chunks. */
function hashFile(path) {
  const fd = openSync(path, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    const hash = createHash('blake2b512');
    const buffer = Buffer.alloc(CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest();
  } finally {
    closeSync(fd);
  }
}

function readWhole(path) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 0x7fffffff) {
      throw new Error('not a regular file of a sane size');
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) throw new Error('the file shrank while it was read');
      offset += read;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Verify `signature` (a `.sig` file's content) over the file at `file` with
 * the committed `pubkey`. Throws an Error (that never contains key or
 * signature material) on any mismatch; returns the trusted comment on success.
 */
export function verifyUpdaterSignature({ pubkey, signature, file }) {
  const key = parsePublicKey(pubkey);
  const sig = parseSignature(signature);
  if (!key.keyId.equals(sig.keyId)) {
    throw new Error('the signature was made by a different key id');
  }
  let message;
  try {
    message = sig.prehashed ? hashFile(file) : readWhole(file);
  } catch {
    throw new Error('the signed file cannot be read as a regular file');
  }
  if (!verify(null, message, key.publicKey, sig.signature)) {
    throw new Error('the signature does not match the file and the public key');
  }
  const bound = Buffer.concat([sig.signature, sig.trustedComment]);
  if (!verify(null, bound, key.publicKey, sig.globalSignature)) {
    throw new Error('the trusted comment signature does not match');
  }
  return sig.trustedComment.toString('utf8');
}
