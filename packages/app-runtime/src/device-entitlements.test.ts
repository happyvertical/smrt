import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_BACKUP_VAULT,
  FEATURE_SYNC_DEVICES,
  FeatureResolver,
  FeatureUnavailableError,
  requireFeature,
  setFeatureGrantSource,
} from '../../features/src/index.js';
import {
  DeviceEntitlementCache,
  type DeviceEntitlementEnvelope,
  type DeviceEntitlementSnapshot,
  FEATURE_GRANT_SOURCE_SLOT_KEY,
  registerDeviceEntitlementGrantSource,
  signDeviceEntitlementSnapshot,
  verifyDeviceEntitlementSnapshot,
} from './device-entitlements.js';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ACCOUNT = 'acct-1';
const DEVICE = 'dev-1';
const KEY_ID = 'issuer-2026-11';

const issuer = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');

function snapshot(
  overrides: Partial<DeviceEntitlementSnapshot> = {},
): DeviceEntitlementSnapshot {
  return {
    accountId: ACCOUNT,
    deviceId: DEVICE,
    featureKeys: [FEATURE_BACKUP_VAULT, FEATURE_SYNC_DEVICES],
    issuedAt: NOW - HOUR,
    expiresAt: NOW + 7 * DAY,
    keyId: KEY_ID,
    ...overrides,
  };
}

function issue(
  overrides: Partial<DeviceEntitlementSnapshot> = {},
  key: KeyObject = issuer.privateKey,
): DeviceEntitlementEnvelope {
  return signDeviceEntitlementSnapshot(snapshot(overrides), key);
}

function trusted() {
  return { [KEY_ID]: issuer.publicKey };
}

function verifyOptions(
  extra: Partial<Parameters<typeof verifyDeviceEntitlementSnapshot>[1]> = {},
) {
  return {
    trustedKeys: trusted(),
    accountId: ACCOUNT,
    deviceId: DEVICE,
    now: () => NOW,
    ...extra,
  };
}

function reasonOf(envelope: unknown, extra = {}) {
  const result = verifyDeviceEntitlementSnapshot(
    envelope,
    verifyOptions(extra),
  );
  return result.ok ? 'ok' : result.reason;
}

/** Re-encode the payload (keeping the old signature) to simulate tampering. */
function tamper(
  envelope: DeviceEntitlementEnvelope,
  change: Record<string, unknown>,
): DeviceEntitlementEnvelope {
  const payload = JSON.parse(
    Buffer.from(envelope.payload, 'base64url').toString('utf8'),
  );
  return {
    ...envelope,
    payload: Buffer.from(
      JSON.stringify({ ...payload, ...change }),
      'utf8',
    ).toString('base64url'),
  };
}

describe('verifyDeviceEntitlementSnapshot', () => {
  it('accepts a valid snapshot', () => {
    const result = verifyDeviceEntitlementSnapshot(issue(), verifyOptions());
    expect(result).toMatchObject({ ok: true, state: 'valid' });
    if (result.ok) {
      expect(result.snapshot.featureKeys).toEqual([
        FEATURE_BACKUP_VAULT,
        FEATURE_SYNC_DEVICES,
      ]);
    }
  });

  it('accepts the JSON text form', () => {
    expect(reasonOf(JSON.stringify(issue()))).toBe('ok');
  });

  it('rejects an expired snapshot', () => {
    expect(reasonOf(issue({ expiresAt: NOW - 1 }))).toBe('expired');
  });

  it('treats the expiry instant itself as still valid, then expired', () => {
    expect(reasonOf(issue({ expiresAt: NOW }))).toBe('ok');
    expect(reasonOf(issue({ expiresAt: NOW - 1 }))).toBe('expired');
  });

  it('honours the grace period and reports it', () => {
    const envelope = issue({
      issuedAt: NOW - 5 * DAY,
      expiresAt: NOW - 2 * DAY,
    });
    expect(reasonOf(envelope, { gracePeriodMs: 3 * DAY })).toBe('ok');
    const result = verifyDeviceEntitlementSnapshot(
      envelope,
      verifyOptions({ gracePeriodMs: 3 * DAY }),
    );
    expect(result).toMatchObject({ ok: true, state: 'grace' });
    expect(reasonOf(envelope, { gracePeriodMs: DAY })).toBe('expired');
    expect(reasonOf(envelope)).toBe('expired');
  });

  it('caps the grace period', () => {
    expect(() =>
      verifyDeviceEntitlementSnapshot(
        issue(),
        verifyOptions({ gracePeriodMs: 365 * DAY }),
      ),
    ).toThrow(RangeError);
  });

  it('rejects wrong account and wrong device', () => {
    expect(reasonOf(issue({ accountId: 'acct-2' }))).toBe('wrong_account');
    expect(reasonOf(issue({ deviceId: 'dev-2' }))).toBe('wrong_device');
  });

  it('bounds clock skew on future-dated snapshots', () => {
    const skew = 5 * 60 * 1000;
    expect(reasonOf(issue({ issuedAt: NOW + skew }))).toBe('ok');
    expect(reasonOf(issue({ issuedAt: NOW + skew + 1 }))).toBe('not_yet_valid');
    expect(reasonOf(issue({ issuedAt: NOW + HOUR }))).toBe('not_yet_valid');
    expect(
      reasonOf(issue({ issuedAt: NOW + 20 * 60 * 1000 }), {
        clockSkewMs: 30 * 60 * 1000,
      }),
    ).toBe('ok');
    expect(() => reasonOf(issue(), { clockSkewMs: 2 * HOUR })).toThrow(
      RangeError,
    );
  });

  it('rejects a lifetime longer than the policy allows', () => {
    expect(
      reasonOf(issue({ issuedAt: NOW - HOUR, expiresAt: NOW + 400 * DAY })),
    ).toBe('invalid_lifetime');
  });

  it('rejects a tampered payload (granting more keys)', () => {
    const envelope = issue({ featureKeys: [FEATURE_SYNC_DEVICES] });
    expect(
      reasonOf(tamper(envelope, { featureKeys: [FEATURE_BACKUP_VAULT] })),
    ).toBe('bad_signature');
    expect(reasonOf(tamper(envelope, { expiresAt: NOW + 80 * DAY }))).toBe(
      'bad_signature',
    );
  });

  it('rejects a tampered signature', () => {
    const envelope = issue();
    const bytes = Buffer.from(envelope.signature, 'base64url');
    bytes[0] ^= 0xff;
    expect(
      reasonOf({ ...envelope, signature: bytes.toString('base64url') }),
    ).toBe('bad_signature');
  });

  it('rejects a snapshot an install signed for itself', () => {
    // Attacker uses the trusted key id but its own key.
    expect(reasonOf(issue({}, attacker.privateKey))).toBe('bad_signature');
    // Attacker invents a key id of its own.
    expect(reasonOf(issue({ keyId: 'evil' }, attacker.privateKey))).toBe(
      'unknown_key',
    );
  });

  it('does not take a key from the snapshot or let the envelope key id differ', () => {
    const envelope = issue();
    expect(reasonOf({ ...envelope, keyId: 'other' })).toBe('unknown_key');
    const twoKeys = {
      [KEY_ID]: issuer.publicKey,
      other: attacker.publicKey,
    };
    // Signed by the issuer, relabelled with another trusted key id: the
    // signature no longer verifies against that key.
    expect(
      reasonOf({ ...envelope, keyId: 'other' }, { trustedKeys: twoKeys }),
    ).toBe('bad_signature');
  });

  it('rejects a payload that names a different key than the envelope', () => {
    const second = generateKeyPairSync('ed25519');
    const envelope = signDeviceEntitlementSnapshot(
      snapshot({ keyId: KEY_ID }),
      second.privateKey,
    );
    const relabelled = { ...envelope, keyId: 'second' };
    expect(
      reasonOf(relabelled, {
        trustedKeys: { [KEY_ID]: issuer.publicKey, second: second.publicKey },
      }),
    ).toBe('malformed');
  });

  it('supports key rotation with several trusted keys', () => {
    const next = generateKeyPairSync('ed25519');
    const options = {
      trustedKeys: new Map([
        [KEY_ID, issuer.publicKey],
        ['issuer-next', next.publicKey],
      ]),
    };
    expect(reasonOf(issue(), options)).toBe('ok');
    expect(
      reasonOf(
        signDeviceEntitlementSnapshot(
          snapshot({ keyId: 'issuer-next' }),
          next.privateKey,
        ),
        options,
      ),
    ).toBe('ok');
  });

  it.each([
    ['empty string', ''],
    ['garbage', 'not json'],
    ['array', []],
    ['null', null],
    ['number', 7],
    ['missing fields', { version: 1 }],
    ['wrong version', { ...issue(), version: 2 }],
    ['non-base64url payload', { ...issue(), payload: '!!!' }],
    ['short signature', { ...issue(), signature: 'AAAA' }],
    ['oversized', 'x'.repeat(100_000)],
  ])('treats %s as malformed without throwing', (_name, value) => {
    expect(reasonOf(value)).toBe('malformed');
  });

  it('validates signed content too, not just the signature', () => {
    // A correctly signed payload with bad field types is still refused.
    const signRaw = (payload: Record<string, unknown>) => {
      const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
      return {
        version: 1,
        keyId: KEY_ID,
        payload: bytes.toString('base64url'),
        signature: sign(
          null,
          Buffer.concat([
            Buffer.from('smrt-device-entitlement-v1\0', 'utf8'),
            bytes,
          ]),
          issuer.privateKey,
        ).toString('base64url'),
      };
    };
    const good = {
      version: 1,
      ...snapshot(),
    };
    expect(reasonOf(signRaw(good))).toBe('ok');
    for (const bad of [
      { featureKeys: 'sync.devices' },
      { featureKeys: ['a', 'a'] },
      { featureKeys: ['has space'] },
      { featureKeys: [7] },
      { issuedAt: '1' },
      { issuedAt: 1.5 },
      { expiresAt: null },
      { accountId: '' },
      { version: 2 },
    ]) {
      expect(reasonOf(signRaw({ ...good, ...bad }))).toBe('malformed');
    }
    // Unsigned domain: a signature over the bare payload does not verify.
    const bytes = Buffer.from(JSON.stringify(good), 'utf8');
    expect(
      reasonOf({
        version: 1,
        keyId: KEY_ID,
        payload: bytes.toString('base64url'),
        signature: sign(null, bytes, issuer.privateKey).toString('base64url'),
      }),
    ).toBe('bad_signature');
  });

  it('round-trips a maximal snapshot within the storage cap', () => {
    const featureKeys = Array.from(
      { length: 64 },
      (_, index) => `${'k'.repeat(120)}.${String(index).padStart(7, '0')}`,
    );
    expect(featureKeys[0]).toHaveLength(128);
    const envelope = issue({ featureKeys });
    expect(JSON.stringify(envelope).length).toBeLessThan(32 * 1024);
    expect(reasonOf(envelope)).toBe('ok');
    expect(() => issue({ featureKeys: [...featureKeys, 'one.more'] })).toThrow(
      TypeError,
    );
  });

  it('treats a throwing or junk clock as fail-closed', () => {
    expect(reasonOf(issue(), { now: () => Number.NaN })).toBe('unreadable');
    expect(
      reasonOf(issue(), {
        now: () => {
          throw new Error('clock');
        },
      }),
    ).toBe('unreadable');
  });

  it('refuses to sign an invalid snapshot', () => {
    for (const bad of [
      { featureKeys: ['a', 'a'] },
      { featureKeys: ['has space'] },
      { expiresAt: NOW - 2 * HOUR },
    ]) {
      expect(() =>
        signDeviceEntitlementSnapshot(snapshot(bad), issuer.privateKey),
      ).toThrow(TypeError);
    }
  });

  it('refuses invalid trust configuration', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const base = { accountId: ACCOUNT, deviceId: DEVICE };
    expect(() =>
      verifyDeviceEntitlementSnapshot(issue(), {
        ...base,
        trustedKeys: { [KEY_ID]: rsa.publicKey },
      }),
    ).toThrow(/Ed25519/);
    expect(() =>
      verifyDeviceEntitlementSnapshot(issue(), {
        ...base,
        trustedKeys: { [KEY_ID]: issuer.privateKey },
      }),
    ).toThrow(/public key/);
    expect(() =>
      verifyDeviceEntitlementSnapshot(issue(), {
        ...base,
        trustedKeys: {
          [KEY_ID]: issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        },
      }),
    ).toThrow(/public key/);
    expect(() =>
      verifyDeviceEntitlementSnapshot(issue(), { ...base, trustedKeys: {} }),
    ).toThrow(/At least one/);
    expect(() =>
      verifyDeviceEntitlementSnapshot(issue(), {
        ...base,
        trustedKeys: {
          [KEY_ID]: {
            ...issuer.privateKey.export({ format: 'jwk' }),
          },
        },
      }),
    ).toThrow(/private/);
  });

  it('accepts PEM and JWK public keys', () => {
    const pem = issuer.publicKey.export({ type: 'spki', format: 'pem' });
    const jwk = issuer.publicKey.export({ format: 'jwk' });
    expect(reasonOf(issue(), { trustedKeys: { [KEY_ID]: pem } })).toBe('ok');
    expect(reasonOf(issue(), { trustedKeys: { [KEY_ID]: jwk } })).toBe('ok');
  });
});

describe('DeviceEntitlementCache', () => {
  let dir: string;
  let file: string;
  let clock: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'smrt-entitlement-'));
    file = join(dir, 'state', 'entitlement.json');
    clock = NOW;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function cache(
    extra: Partial<
      ConstructorParameters<typeof DeviceEntitlementCache>[0]
    > = {},
  ) {
    return new DeviceEntitlementCache({
      trustedKeys: trusted(),
      accountId: ACCOUNT,
      deviceId: DEVICE,
      filePath: file,
      now: () => clock,
      ...extra,
    });
  }

  const LOCAL = {
    tier: 'local',
    featureKeys: [],
  };

  it('is the Local tier with no paid keys when nothing is cached', async () => {
    expect(await cache().status()).toMatchObject({
      ...LOCAL,
      state: 'absent',
      reason: 'absent',
    });
    expect(await cache().grantSource().getGrants('t1')).toBeNull();
  });

  it('enables the granted keys from a valid snapshot', async () => {
    const result = await cache().install(issue());
    expect(result.accepted).toBe(true);
    const status = await cache().status();
    expect(status).toMatchObject({
      tier: 'entitled',
      state: 'valid',
      featureKeys: [FEATURE_BACKUP_VAULT, FEATURE_SYNC_DEVICES],
      expiresAt: NOW + 7 * DAY,
    });
    expect(await cache().grantSource().getGrants('t1')).toEqual({
      featureKeys: [FEATURE_BACKUP_VAULT, FEATURE_SYNC_DEVICES],
      planKey: null,
    });
  });

  it('stores the cache with owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    await cache().install(issue());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(`${file}.watermark`)).mode & 0o777).toBe(0o600);
  });

  it('turns paid keys off when the snapshot expires, and back on in grace', async () => {
    await cache().install(issue({ expiresAt: NOW + HOUR }));
    clock = NOW + 2 * HOUR;
    expect(await cache().status()).toMatchObject({
      ...LOCAL,
      state: 'expired',
      reason: 'expired',
    });
    const graceful = await cache({ gracePeriodMs: DAY }).status();
    expect(graceful).toMatchObject({ tier: 'entitled', state: 'grace' });
    expect(graceful.graceEndsAt).toBe(NOW + HOUR + DAY);
    clock = NOW + 2 * DAY;
    expect(await cache({ gracePeriodMs: DAY }).status()).toMatchObject({
      ...LOCAL,
      state: 'expired',
    });
  });

  it('refuses snapshots for another account or device and keeps the old one', async () => {
    await cache().install(issue());
    for (const [overrides, reason] of [
      [{ accountId: 'acct-2', issuedAt: NOW }, 'wrong_account'],
      [{ deviceId: 'dev-2', issuedAt: NOW }, 'wrong_device'],
    ] as const) {
      const result = await cache().install(issue(overrides));
      expect(result).toMatchObject({ accepted: false, reason });
      expect(result.status.tier).toBe('entitled');
    }
  });

  it('refuses a self-signed snapshot and never writes it', async () => {
    const result = await cache().install(issue({}, attacker.privateKey));
    expect(result).toMatchObject({ accepted: false, reason: 'bad_signature' });
    expect(result.status.tier).toBe('local');
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('refuses a tampered cache file written by the user', async () => {
    await cache().install(issue({ featureKeys: [FEATURE_SYNC_DEVICES] }));
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(
      file,
      JSON.stringify(tamper(stored, { featureKeys: [FEATURE_BACKUP_VAULT] })),
    );
    expect(await cache().status()).toMatchObject({
      ...LOCAL,
      state: 'invalid',
      reason: 'bad_signature',
    });
  });

  it('refuses a self-minted cache file dropped in place', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(file, JSON.stringify(issue({}, attacker.privateKey)));
    expect((await cache().status()).tier).toBe('local');
  });

  it('rejects an older snapshot after a newer one (replay)', async () => {
    const older = issue({
      issuedAt: NOW - 2 * DAY,
      featureKeys: [FEATURE_BACKUP_VAULT],
    });
    const newer = issue({ issuedAt: NOW - HOUR, featureKeys: [] });
    expect((await cache().install(newer)).accepted).toBe(true);
    const replay = await cache().install(older);
    expect(replay).toMatchObject({ accepted: false, reason: 'replayed' });
    expect(replay.status.featureKeys).toEqual([]);
  });

  it('rejects an old backup swapped over the cache file', async () => {
    const older = issue({
      issuedAt: NOW - 2 * DAY,
      featureKeys: [FEATURE_BACKUP_VAULT],
    });
    await cache().install(older);
    await cache().install(issue({ issuedAt: NOW - HOUR, featureKeys: [] }));
    await writeFile(file, JSON.stringify(older));
    expect(await cache().status()).toMatchObject({
      ...LOCAL,
      state: 'invalid',
      reason: 'replayed',
    });
  });

  it('is idempotent for the same snapshot and refuses a conflicting one at the same instant', async () => {
    const first = issue();
    expect((await cache().install(first)).accepted).toBe(true);
    expect((await cache().install(first)).accepted).toBe(true);
    const sibling = issue({ featureKeys: [] });
    expect(await cache().install(sibling)).toMatchObject({
      accepted: false,
      reason: 'replayed',
    });
  });

  it('accepts a newer snapshot over an older one', async () => {
    await cache().install(issue({ issuedAt: NOW - 2 * DAY }));
    const result = await cache().install(
      issue({ issuedAt: NOW - HOUR, featureKeys: [FEATURE_SYNC_DEVICES] }),
    );
    expect(result.accepted).toBe(true);
    expect(result.status.featureKeys).toEqual([FEATURE_SYNC_DEVICES]);
  });

  it('treats a future-dated cache as invalid until the clock catches up', async () => {
    clock = NOW - DAY;
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(file, JSON.stringify(issue({ issuedAt: NOW })));
    expect(await cache().status()).toMatchObject({
      ...LOCAL,
      reason: 'not_yet_valid',
    });
    clock = NOW;
    expect((await cache().status()).tier).toBe('entitled');
  });

  it.each([
    ['empty file', ''],
    ['garbage', '\u0000\u0001 not json'],
    ['truncated JSON', '{"version":1,"keyId":"issuer-20'],
    ['oversized file', 'x'.repeat(200_000)],
    ['wrong shape', '[]'],
  ])('is Local, with no error, for a corrupt cache: %s', async (_n, content) => {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(file, content);
    const status = await cache().status();
    expect(status.tier).toBe('local');
    expect(status.featureKeys).toEqual([]);
    expect(['malformed', 'unreadable']).toContain(status.reason);
  });

  it('is Local when the cache path is unreadable (a directory)', async () => {
    await mkdir(file, { recursive: true });
    expect(await cache().status()).toMatchObject({
      ...LOCAL,
      reason: 'unreadable',
    });
  });

  it('is Local when the cache file cannot be opened', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await cache().install(issue());
    await chmod(file, 0o000);
    try {
      expect((await cache().status()).tier).toBe('local');
    } finally {
      await chmod(file, 0o600);
    }
  });

  it('is Local when the watermark is corrupt, and a valid install repairs it', async () => {
    await cache().install(issue());
    await writeFile(`${file}.watermark`, 'garbage');
    expect(await cache().status()).toMatchObject({
      ...LOCAL,
      reason: 'unreadable',
    });
    expect(
      (await cache().install(issue({ issuedAt: NOW - 1000 }))).accepted,
    ).toBe(true);
    expect((await cache().status()).tier).toBe('entitled');
  });

  it('reports a storage failure as a refusal, not an exception', async () => {
    await mkdir(file, { recursive: true });
    const result = await cache().install(issue());
    expect(result).toMatchObject({ accepted: false, reason: 'storage_failed' });
    expect(result.status.tier).toBe('local');
  });

  it('limits grants to the install tenant when asked', async () => {
    await cache().install(issue());
    const source = cache().grantSource({ tenantId: 'local-tenant' });
    expect(await source.getGrants('someone-else')).toBeNull();
    expect((await source.getGrants('local-tenant'))?.featureKeys).toContain(
      FEATURE_BACKUP_VAULT,
    );
  });

  describe('refresh', () => {
    it('installs what the injected transport returns', async () => {
      const transport = vi.fn(async () => issue());
      const result = await cache({ transport }).refresh();
      expect(result.accepted).toBe(true);
      expect(result.status.tier).toBe('entitled');
      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT,
          deviceId: DEVICE,
          currentIssuedAt: null,
        }),
      );
    });

    it('passes the held issuedAt so the host can skip an unchanged tier', async () => {
      await cache().install(issue());
      const transport = vi.fn(async () => issue());
      await cache({ transport }).refresh();
      expect(transport.mock.calls[0][0].currentIssuedAt).toBe(NOW - HOUR);
    });

    it('keeps a valid snapshot when the transport fails', async () => {
      await cache().install(issue());
      const result = await cache({
        transport: async () => {
          throw new Error('offline: secret-host.example');
        },
      }).refresh();
      expect(result).toMatchObject({
        accepted: false,
        reason: 'transport_failed',
      });
      expect(result.status.tier).toBe('entitled');
      expect(JSON.stringify(result)).not.toContain('secret-host');
    });

    it('keeps the cache when the transport returns junk, a forgery, or a replay', async () => {
      await cache().install(issue());
      for (const [offered, reason] of [
        ['junk', 'malformed'],
        [issue({ issuedAt: NOW }, attacker.privateKey), 'bad_signature'],
        [issue({ issuedAt: NOW - 3 * DAY }), 'replayed'],
      ] as const) {
        const result = await cache({
          transport: async () => offered,
        }).refresh();
        expect(result).toMatchObject({ accepted: false, reason });
        expect(result.status.tier).toBe('entitled');
      }
    });

    it('aborts a hung transport after the timeout', async () => {
      const seen: AbortSignal[] = [];
      const result = await cache({
        refreshTimeoutMs: 20,
        transport: ({ signal }) => {
          seen.push(signal);
          return new Promise(() => undefined);
        },
      }).refresh();
      expect(result).toMatchObject({
        accepted: false,
        reason: 'transport_failed',
      });
      expect(seen[0].aborted).toBe(true);
    });

    it('reports transport_failed when no transport is configured', async () => {
      expect(await cache().refresh()).toMatchObject({
        accepted: false,
        reason: 'transport_failed',
      });
    });
  });

  describe('through smrt-features requireFeature', () => {
    const closers: Array<() => Promise<void>> = [];

    afterEach(async () => {
      setFeatureGrantSource(undefined);
      for (const close of closers.splice(0)) await close();
    });

    async function resolver() {
      const db = await getTestDatabase({
        classes: ['FeatureDefinition', 'FeatureOverride'],
      });
      closers.push(async () => {
        await (db as { close?: () => Promise<void> }).close?.();
      });
      return new FeatureResolver(
        { db },
        { tenantHierarchyLoader: async () => null },
      );
    }

    it('keeps paid keys off with no snapshot', async () => {
      const features = await resolver();
      const grantSource = cache().grantSource();
      await expect(
        requireFeature(FEATURE_BACKUP_VAULT, {
          resolver: features,
          tenantId: 'local',
          grantSource,
        }),
      ).rejects.toBeInstanceOf(FeatureUnavailableError);
    });

    it('opens exactly the granted keys with a valid snapshot', async () => {
      await cache().install(issue({ featureKeys: [FEATURE_BACKUP_VAULT] }));
      const features = await resolver();
      const grantSource = cache().grantSource();
      await expect(
        requireFeature(FEATURE_BACKUP_VAULT, {
          resolver: features,
          tenantId: 'local',
          grantSource,
        }),
      ).resolves.toBeUndefined();
      await expect(
        requireFeature(FEATURE_SYNC_DEVICES, {
          resolver: features,
          tenantId: 'local',
          grantSource,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'feature_upgrade_required',
      });
    });

    it('closes again when the snapshot expires', async () => {
      await cache().install(issue({ expiresAt: NOW + HOUR }));
      const features = await resolver();
      const grantSource = cache().grantSource();
      const gate = () =>
        requireFeature(FEATURE_BACKUP_VAULT, {
          resolver: features,
          tenantId: 'local',
          grantSource,
        });
      await expect(gate()).resolves.toBeUndefined();
      clock = NOW + 2 * HOUR;
      await expect(gate()).rejects.toBeInstanceOf(FeatureUnavailableError);
    });

    it('registers app-wide through the features grant slot and restores it', async () => {
      await cache().install(issue());
      const features = await resolver();
      const source = cache().grantSource();
      const unregister = registerDeviceEntitlementGrantSource(source);
      expect(FEATURE_GRANT_SOURCE_SLOT_KEY).toBe(
        '@happyvertical/smrt-features:grant-source',
      );
      await expect(
        features.isEnabled(FEATURE_BACKUP_VAULT, { tenantId: 'local' }),
      ).resolves.toBe(true);
      unregister();
      await expect(
        features.isEnabled(FEATURE_BACKUP_VAULT, { tenantId: 'local' }),
      ).resolves.toBe(false);
    });
  });
});
