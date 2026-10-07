import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Base64Url, sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
  it('matches the published SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with node:crypto on multi-block, multi-byte and unpaired-surrogate input', () => {
    const inputs = [
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'a'.repeat(1_000_003),
      'ünïcödé 日本語 🎉',
      '\ud800 lone high surrogate',
      randomBytes(512).toString('latin1'),
      JSON.stringify({ columns: [{ name: 'id', type: 'UUID' }] }),
    ];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(
        createHash('sha256').update(input).digest('hex'),
      );
    }
  });

  it('matches Node base64url digests', () => {
    for (const input of ['', 'abc', 'ünïcödé 日本語 🎉', 'a'.repeat(1000)]) {
      expect(sha256Base64Url(input)).toBe(
        createHash('sha256').update(input).digest('base64url'),
      );
    }
  });
});
