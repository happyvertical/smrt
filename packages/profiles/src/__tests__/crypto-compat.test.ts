/**
 * Byte-for-byte compatibility of the portable crypto helpers (#3617) with the
 * `node:crypto` calls they replaced. Persisted API key hashes, magic-link
 * hashes, and encrypted Nostr keys must keep working across the change.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeEventId,
  decryptPrivkey,
  deriveEncryptionKey,
  encryptPrivkey,
} from '../auth/nostrCrypto.js';
import { bytesToBase64Url, bytesToHex, sha256Hex } from '../crypto-util.js';
import { ApiKey } from '../models/ApiKey.js';
import { MagicLinkToken } from '../models/MagicLinkToken.js';

const SECRET = 'test-master-secret';
const PRIVKEY = '11'.repeat(32);

describe('portable crypto compatibility with node:crypto', () => {
  it('hashes API keys and magic-link tokens exactly as before (fixed vector)', () => {
    expect(ApiKey.hashKey('sk_live_abc')).toBe(
      'b2817799acd7f3337c32f967a7c4ca32a767c94190298bace3e0447120385c09',
    );
    expect(MagicLinkToken.hashToken('sk_live_abc')).toBe(
      'b2817799acd7f3337c32f967a7c4ca32a767c94190298bace3e0447120385c09',
    );
  });

  it('matches node sha256 for ascii, unicode, and empty input', () => {
    for (const input of ['', 'a', 'sk_live_é✓', 'x'.repeat(1000)]) {
      expect(sha256Hex(input)).toBe(
        createHash('sha256').update(input).digest('hex'),
      );
    }
  });

  it('derives the same HKDF key (fixed vector and node parity)', () => {
    const key = deriveEncryptionKey(SECRET);
    expect(bytesToHex(key)).toBe(
      '8a7500b7283bf528833c99639be6e86571a70499bd71f976357c125b1b61bf17',
    );
    const nodeKey = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from('ünïcode-secret'),
        Buffer.from('nostr-privkey-encryption'),
        Buffer.from('aes-256-gcm'),
        32,
      ),
    );
    expect(Buffer.from(deriveEncryptionKey('ünïcode-secret'))).toEqual(nodeKey);
  });

  it('decrypts a ciphertext produced by node:crypto (fixed vector)', () => {
    expect(
      decryptPrivkey(
        {
          ciphertext:
            'E9Onris92nr9TKqTV0qfs+5wBaakUR0GflcS19CBwRxsiP/b6UhOAupm4p3PdvYnljC60JhxVkKMXj8krSF0jQ==',
          iv: 'BwcHBwcHBwcHBwcH',
          tag: 'IAgJrwIFsO105jsDQ2pLjg==',
        },
        SECRET,
      ),
    ).toBe(PRIVKEY);
  });

  it('encrypts to something node:crypto can decrypt, and round-trips', () => {
    const enc = encryptPrivkey(PRIVKEY, SECRET);
    expect(decryptPrivkey(enc, SECRET)).toBe(PRIVKEY);

    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(deriveEncryptionKey(SECRET)),
      Buffer.from(enc.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(enc.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    expect(plain).toBe(PRIVKEY);
  });

  it('produces node-identical ciphertext for the same iv', () => {
    const key = Buffer.from(deriveEncryptionKey(SECRET));
    const iv = nodeRandomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(PRIVKEY, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    expect(
      decryptPrivkey(
        {
          ciphertext: ct.toString('base64'),
          iv: iv.toString('base64'),
          tag: tag.toString('base64'),
        },
        SECRET,
      ),
    ).toBe(PRIVKEY);
  });

  it('rejects tampered ciphertext, tag, and wrong secret', () => {
    const enc = encryptPrivkey(PRIVKEY, SECRET);
    const flipped = Buffer.from(enc.ciphertext, 'base64');
    flipped[0] ^= 1;
    expect(() =>
      decryptPrivkey(
        { ...enc, ciphertext: flipped.toString('base64') },
        SECRET,
      ),
    ).toThrow();
    const badTag = Buffer.from(enc.tag, 'base64');
    badTag[0] ^= 1;
    expect(() =>
      decryptPrivkey({ ...enc, tag: badTag.toString('base64') }, SECRET),
    ).toThrow();
    expect(() => decryptPrivkey(enc, 'wrong-secret')).toThrow();
  });

  it('computes the NIP-01 event id like node sha256', () => {
    const event = {
      pubkey: 'ab'.repeat(32),
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'x']],
      content: 'héllo',
    };
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          0,
          event.pubkey,
          event.created_at,
          event.kind,
          event.tags,
          event.content,
        ]),
      )
      .digest('hex');
    expect(computeEventId(event)).toBe(expected);
  });

  it('encodes base64url like Buffer', () => {
    const bytes = nodeRandomBytes(32);
    expect(bytesToBase64Url(bytes)).toBe(
      Buffer.from(bytes).toString('base64url'),
    );
  });
});
