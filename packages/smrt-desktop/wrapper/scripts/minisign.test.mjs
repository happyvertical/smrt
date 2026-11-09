// Run with: node --test scripts/minisign.test.mjs
// Keys are generated in this process; nothing is a real credential.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { makeKey, signBytes } from './minisign-fixture.mjs';
import {
  parsePublicKey,
  parseSignature,
  verifyUpdaterSignature,
} from './minisign.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
const payloadFile = (text = 'payload bytes') => {
  const dir = mkdtempSync(join(tmpdir(), 'minisign-'));
  dirs.push(dir);
  const file = join(dir, 'payload.bin');
  writeFileSync(file, text);
  return file;
};
const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');
const encode = (text) => Buffer.from(text).toString('base64');

describe('verifyUpdaterSignature', () => {
  const key = makeKey();
  const bytes = 'payload bytes';
  let file;
  beforeEach(() => {
    file = payloadFile();
  });

  it('accepts a prehashed (ED) signature, the variant Tauri emits', () => {
    const signature = signBytes(key, bytes);
    assert.match(
      verifyUpdaterSignature({ pubkey: key.pubkey, signature, file }),
      /^timestamp:\d+\tfile:payload\.bin$/,
    );
  });

  it('accepts a legacy (Ed) signature', () => {
    const signature = signBytes(key, bytes, { prehashed: false });
    assert.ok(verifyUpdaterSignature({ pubkey: key.pubkey, signature, file }));
  });

  it('accepts the signature with a trailing newline, as read from a file', () => {
    const signature = `${signBytes(key, bytes)}\n`;
    assert.ok(verifyUpdaterSignature({ pubkey: key.pubkey, signature, file }));
  });

  it('refuses a signature made by another key pair', () => {
    const other = makeKey(key.keyId); // same key id, different key
    const signature = signBytes(other, bytes);
    assert.throws(
      () => verifyUpdaterSignature({ pubkey: key.pubkey, signature, file }),
      /does not match/,
    );
  });

  it('refuses a different key id before checking anything else', () => {
    const other = makeKey();
    const signature = signBytes(other, bytes);
    assert.throws(
      () => verifyUpdaterSignature({ pubkey: key.pubkey, signature, file }),
      /different key id/,
    );
    const lying = signBytes(other, bytes, { keyId: key.keyId });
    assert.throws(
      () =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature: lying,
          file,
        }),
      /does not match/,
    );
  });

  it('refuses a tampered payload for both variants', () => {
    for (const prehashed of [true, false]) {
      const signature = signBytes(key, bytes, { prehashed });
      assert.throws(
        () =>
          verifyUpdaterSignature({
            pubkey: key.pubkey,
            signature,
            file: payloadFile('payload bytez'),
          }),
        /does not match/,
      );
    }
  });

  it('refuses a changed trusted comment (global signature)', () => {
    const lines = decode(signBytes(key, bytes)).split('\n');
    lines[2] = 'trusted comment: timestamp:1\tfile:other.bin';
    assert.throws(
      () =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature: encode(lines.join('\n')),
          file,
        }),
      /trusted comment/,
    );
  });

  it('refuses an Ed signature relabelled as ED and the reverse', () => {
    for (const prehashed of [true, false]) {
      const lines = decode(signBytes(key, bytes, { prehashed })).split('\n');
      const body = Buffer.from(lines[1], 'base64');
      body.write(prehashed ? 'Ed' : 'ED', 0, 'latin1');
      lines[1] = body.toString('base64');
      assert.throws(() =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature: encode(lines.join('\n')),
          file,
        }),
      );
    }
  });

  it('refuses a truncated signature', () => {
    const signature = signBytes(key, bytes);
    for (const cut of [10, signature.length - 8, signature.length - 1]) {
      assert.throws(() =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature: signature.slice(0, cut),
          file,
        }),
      );
    }
    const lines = decode(signature).split('\n');
    assert.throws(
      () =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature: encode(`${lines.slice(0, 3).join('\n')}\n`),
          file,
        }),
      /exactly 4 lines/,
    );
  });

  it('refuses trailing garbage after the signature', () => {
    const text = decode(signBytes(key, bytes));
    for (const tail of ['junk\n', '\n', 'trusted comment: x\nAAAA\n']) {
      assert.throws(
        () =>
          verifyUpdaterSignature({
            pubkey: key.pubkey,
            signature: encode(text + tail),
            file,
          }),
        /exactly 4 lines/,
      );
    }
    // garbage after the base64 itself, and non-canonical padding
    const signature = signBytes(key, bytes);
    assert.throws(() =>
      verifyUpdaterSignature({
        pubkey: key.pubkey,
        signature: `${signature}AAAA`,
        file,
      }),
    );
    assert.throws(() =>
      verifyUpdaterSignature({
        pubkey: key.pubkey,
        signature: `${signature} x`,
        file,
      }),
    );
    // extra bytes inside the signature body
    const lines = text.split('\n');
    lines[1] = Buffer.concat([
      Buffer.from(lines[1], 'base64'),
      Buffer.from('x'),
    ]).toString('base64');
    assert.throws(
      () =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature: encode(lines.join('\n')),
          file,
        }),
      /not a minisign/,
    );
  });

  it('refuses CR characters, empty input and a missing file or a directory', () => {
    const text = decode(signBytes(key, bytes));
    assert.throws(() =>
      verifyUpdaterSignature({
        pubkey: key.pubkey,
        signature: encode(text.replace('\n', '\r\n')),
        file,
      }),
    );
    for (const signature of ['', '   ', undefined, 'not base64!!']) {
      assert.throws(() =>
        verifyUpdaterSignature({ pubkey: key.pubkey, signature, file }),
      );
    }
    const signature = signBytes(key, bytes);
    assert.throws(
      () =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature,
          file: join(tmpdir(), 'no-such-minisign-file'),
        }),
      /cannot be read/,
    );
    // a directory is not a file
    assert.throws(
      () =>
        verifyUpdaterSignature({
          pubkey: key.pubkey,
          signature,
          file: tmpdir(),
        }),
      /cannot be read/,
    );
  });

  it('never echoes key or signature material in its errors', () => {
    const signature = signBytes(key, bytes);
    try {
      verifyUpdaterSignature({
        pubkey: key.pubkey,
        signature: signBytes(makeKey(), bytes),
        file,
      });
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(!error.message.includes(key.pubkey));
      assert.ok(!error.message.includes(signature));
    }
  });
});

describe('parsePublicKey', () => {
  const key = makeKey();

  it('parses a Tauri public key and exposes the key id', () => {
    assert.ok(parsePublicKey(key.pubkey).keyId.equals(key.keyId));
  });

  it('refuses a placeholder, a short key, a wrong algorithm and extra lines', () => {
    assert.throws(() => parsePublicKey('PLACEHOLDER-NOT-A-KEY'));
    assert.throws(() => parsePublicKey(''));
    const text = decode(key.pubkey);
    assert.throws(() => parsePublicKey(encode(`${text}extra\n`)), /2 lines/);
    const lines = text.split('\n');
    const body = Buffer.from(lines[1], 'base64');
    assert.throws(
      () =>
        parsePublicKey(
          encode(`${lines[0]}\n${body.subarray(0, 41).toString('base64')}\n`),
        ),
      /not a minisign/,
    );
    body.write('XX', 0, 'latin1');
    assert.throws(
      () =>
        parsePublicKey(encode(`${lines[0]}\n${body.toString('base64')}\n`)),
      /not a minisign/,
    );
  });
});

describe('parseSignature', () => {
  it('reads the variant, key id and trusted comment', () => {
    const key = makeKey();
    const parsed = parseSignature(signBytes(key, 'x'));
    assert.equal(parsed.prehashed, true);
    assert.ok(parsed.keyId.equals(key.keyId));
    assert.equal(parseSignature(signBytes(key, 'x', { prehashed: false })).prehashed, false);
  });
});
