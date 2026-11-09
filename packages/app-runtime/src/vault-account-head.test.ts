import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accountCode,
  authorityPublicKey,
  codesMatch,
  containsState,
  deviceCode,
  headDigest,
  parseHead,
  serializeHead,
  signHead,
  unionState,
  type VaultHead,
} from './vault-account-head.js';

const seed = new Uint8Array(randomBytes(32));
const key = (fill: number) => Buffer.alloc(32, fill).toString('base64url');
const digest = (fill: number) => Buffer.alloc(32, fill).toString('base64url');

function head(patch: Partial<VaultHead> = {}): VaultHead {
  return signHead(
    {
      accountId: 'account',
      sequence: 1n,
      issuedAt: '2026-01-01T00:00:00.000Z',
      issuerDeviceId: 'a',
      current: { generation: 1n, keyId: '1'.repeat(32) },
      generations: [
        {
          generation: 1n,
          keyId: '1'.repeat(32),
          keyCommitment: digest(1),
          recoveryDigest: digest(2),
        },
      ],
      devices: [
        { deviceId: 'b', publicKey: key(2), enrolledAt: '2026-01-01T00:00Z' },
        { deviceId: 'a', publicKey: key(1), enrolledAt: '2026-01-01T00:00Z' },
      ],
      revokedDevices: [],
      authorityPublicKey: Buffer.from(authorityPublicKey(seed)).toString(
        'base64url',
      ),
      authorityRecordDigest: digest(3),
      ...patch,
    },
    seed,
  );
}

describe('vault account heads', () => {
  it('signs a canonical encoding independent of JSON order and number limits', () => {
    const signed = head({ sequence: (1n << 63n) + 7n });
    const transport = serializeHead(signed);
    expect(transport.sequence).toBe(((1n << 63n) + 7n).toString());
    const reordered = {
      ...transport,
      devices: [...transport.devices].reverse(),
    };
    expect(headDigest(parseHead(reordered))).toEqual(headDigest(signed));
    expect(() =>
      parseHead({ ...transport, sequence: ((1n << 63n) + 8n).toString() }),
    ).toThrow('Invalid vault account head');
    expect(() =>
      parseHead({ ...transport, issuerDeviceId: 'unknown' }),
    ).toThrow('Invalid vault account head');
    // A head for another authority key cannot be produced from this seed.
    expect(() =>
      signHead({ ...signed, authorityPublicKey: key(9) }, seed),
    ).toThrow('Invalid vault account head');
  });

  it('decides containment from content, not arrival order', () => {
    const base = head();
    const later = head({
      sequence: 2n,
      devices: [
        ...base.devices,
        { deviceId: 'c', publicKey: key(3), enrolledAt: base.issuedAt },
      ],
    });
    const fork = head({
      sequence: 2n,
      current: { generation: 2n, keyId: '2'.repeat(32) },
      generations: [
        ...base.generations,
        {
          generation: 2n,
          keyId: '2'.repeat(32),
          keyCommitment: digest(4),
          recoveryDigest: digest(5),
        },
      ],
    });
    expect(containsState(later, base)).toBe(true);
    expect(containsState(base, later)).toBe(false);
    expect(containsState(later, fork)).toBe(false);
    expect(containsState(fork, later)).toBe(false);
    const merged = unionState([later, fork]);
    expect(containsState(merged, later)).toBe(true);
    expect(containsState(merged, fork)).toBe(true);
    // A revocation in one branch removes the device from the union.
    const revoked = unionState([
      later,
      {
        ...fork,
        revokedDevices: [
          {
            deviceId: 'c',
            publicKey: key(3),
            revokedAt: base.issuedAt,
            effectiveGeneration: 2n,
          },
        ],
      },
    ]);
    expect(revoked.devices.map((device) => device.deviceId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('merges revocations at the earliest effective generation', () => {
    const base = head();
    const revocation = (effectiveGeneration: bigint) => ({
      ...base,
      devices: base.devices.filter((device) => device.deviceId !== 'b'),
      revokedDevices: [
        {
          deviceId: 'b',
          publicKey: key(2),
          revokedAt: base.issuedAt,
          effectiveGeneration,
        },
      ],
    });
    const early = revocation(2n);
    const late = revocation(3n);
    const merged = unionState([late, early]);
    expect(merged.revokedDevices[0].effectiveGeneration).toBe(2n);
    expect(unionState([early, late])).toEqual(merged);
    expect(containsState(merged, late)).toBe(true);
    expect(containsState(merged, early)).toBe(true);
    expect(containsState(late, early)).toBe(false);
  });

  it('derives request-bound confirmation codes', () => {
    const request = {
      accountId: 'account',
      deviceId: 'phone',
      publicKey: key(1),
      nonce: Buffer.alloc(16, 1).toString('base64url'),
      expiresAt: '2026-01-01T00:10:00.000Z',
    };
    const code = deviceCode(request);
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(deviceCode({ ...request, publicKey: key(2) })).not.toBe(code);
    expect(
      deviceCode({ ...request, nonce: Buffer.alloc(16).toString('base64url') }),
    ).not.toBe(code);
    expect(codesMatch(code, code.toLowerCase().replace(/-/g, ' '))).toBe(true);
    expect(codesMatch(code, 'AAAA-AAAA-AAAA')).toBe(false);
    expect(codesMatch(code, 42)).toBe(false);
    const signed = head();
    const account = {
      accountId: 'account',
      authorityPublicKey: signed.authorityPublicKey,
      headDigest: headDigest(signed),
      devicePublicKey: key(1),
      nonce: request.nonce,
    };
    expect(accountCode(account)).not.toBe(
      accountCode({
        ...account,
        headDigest: headDigest(head({ sequence: 2n })),
      }),
    );
  });
});
