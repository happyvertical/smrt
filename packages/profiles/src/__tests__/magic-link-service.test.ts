/**
 * Tests for the magic link authentication service (createMagicLinkService) and
 * the rate-limiting / lifecycle helpers on MagicLinkTokenCollection.
 *
 * Real file-backed SQLite, no DB mocking. The only injected dependency is the
 * sendEmail callback (an external side effect), which we stub to capture the
 * generated link.
 *
 * NOTE: `initiate()`'s brand-new-user branch builds a `Person` without a
 * `typeId` and saves it, which fails Profile's required-FK validation — a
 * pre-existing defect in magicLinkService.ts (the file previously had no
 * coverage). These tests therefore exercise the service against a
 * pre-existing, correctly-typed identity (the "returning user" path), which
 * still covers rate limiting, token generation, email delivery, and the full
 * verify() flow.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMagicLinkService,
  type MagicLinkConfig,
  MagicLinkToken,
  MagicLinkTokenCollection,
  NostrIdentityCollection,
  ProfileCollection,
  ProfileTypeCollection,
} from '../index.js';

const TEST_MASTER_SECRET = 'test-master-secret-32-bytes-long';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token') as string;
}

function makeService(
  dbUrl: string,
  overrides: Partial<MagicLinkConfig> = {},
): {
  service: ReturnType<typeof createMagicLinkService>;
  sentLinks: string[];
} {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const sentLinks: string[] = [];

  const service = createMagicLinkService({
    baseUrl: 'https://example.com',
    masterSecret: TEST_MASTER_SECRET,
    sendEmail: async (_to, link) => {
      sentLinks.push(link);
    },
    db,
    ...overrides,
  });

  return { service, sentLinks };
}

/**
 * Seed a properly-typed Profile + NostrIdentity for `email` so the service can
 * treat the caller as a returning user.
 */
async function seedIdentity(dbUrl: string, email: string) {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const profileTypes = await ProfileTypeCollection.create({ db });
  const type = await profileTypes.create({ name: 'Person' });
  await type.save();

  const profiles = await ProfileCollection.create({ db });
  const profile = await profiles.create({
    typeId: type.id,
    name: 'Returning User',
    email,
  });
  await profile.save();

  const identities = await NostrIdentityCollection.create({ db });
  const identity = await identities.createForProfile(
    profile,
    email,
    TEST_MASTER_SECRET,
  );

  return { db, profile, identity };
}

describe('createMagicLinkService.initiate', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('magic-link-initiate');
  });

  it('reuses an existing identity and sends a link', async () => {
    const email = `existing-${randomUUID()}@example.com`;
    const { profile } = await seedIdentity(dbUrl, email);
    const { service, sentLinks } = makeService(dbUrl);

    const result = await service.initiate(email);

    expect(result.success).toBe(true);
    expect(result.created).toBe(false);
    expect(result.profile?.id).toBe(profile.id);
    expect(sentLinks).toHaveLength(1);
    expect(sentLinks[0]).toContain('https://example.com/auth/verify?token=');
  });

  it('rate-limits by email', async () => {
    const email = `rl-email-${randomUUID()}@example.com`;
    await seedIdentity(dbUrl, email);
    const { service } = makeService(dbUrl, { maxTokensPerEmailPerHour: 1 });

    const first = await service.initiate(email);
    expect(first.success).toBe(true);

    const second = await service.initiate(email);
    expect(second.success).toBe(false);
    expect(second.errorCode).toBe('RATE_LIMITED_EMAIL');
  });

  it('rate-limits by IP', async () => {
    const email = `rl-ip-${randomUUID()}@example.com`;
    await seedIdentity(dbUrl, email);
    const { service } = makeService(dbUrl, {
      maxTokensPerEmailPerHour: 10,
      maxTokensPerIpPerHour: 1,
    });
    const ip = '203.0.113.7';

    const first = await service.initiate(email, { requestedFromIp: ip });
    expect(first.success).toBe(true);

    const second = await service.initiate(email, { requestedFromIp: ip });
    expect(second.success).toBe(false);
    expect(second.errorCode).toBe('RATE_LIMITED_IP');
  });

  it('reports EMAIL_SEND_FAILED when the email callback throws', async () => {
    const email = `fail-${randomUUID()}@example.com`;
    await seedIdentity(dbUrl, email);
    const { service } = makeService(dbUrl, {
      sendEmail: vi.fn().mockRejectedValue(new Error('smtp down')),
    });

    const result = await service.initiate(email);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('EMAIL_SEND_FAILED');
    expect(result.nostrIdentity).toBeDefined();
  });
});

describe('createMagicLinkService.verify', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('magic-link-verify');
  });

  it('verifies a valid token and returns the decrypted keypair', async () => {
    const email = `verify-${randomUUID()}@example.com`;
    const { profile } = await seedIdentity(dbUrl, email);
    const { service, sentLinks } = makeService(dbUrl);

    await service.initiate(email);
    const token = tokenFromLink(sentLinks[0]);

    const result = await service.verify(token);
    expect(result.success).toBe(true);
    expect(result.profile?.id).toBe(profile.id);
    expect(result.nostrIdentity?.isVerified()).toBe(true);
    expect(result.keypair?.npub.startsWith('npub1')).toBe(true);
    expect(result.keypair?.nsec.startsWith('nsec1')).toBe(true);
  });

  it('returns NOT_FOUND for an unknown token', async () => {
    await seedIdentity(dbUrl, `seed-${randomUUID()}@example.com`);
    const { service } = makeService(dbUrl);

    const result = await service.verify('totally-made-up-token');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });

  it('returns USED_TOKEN when a token is replayed', async () => {
    const email = `used-${randomUUID()}@example.com`;
    await seedIdentity(dbUrl, email);
    const { service, sentLinks } = makeService(dbUrl);

    await service.initiate(email);
    const token = tokenFromLink(sentLinks[0]);

    expect((await service.verify(token)).success).toBe(true);
    const replay = await service.verify(token);
    expect(replay.success).toBe(false);
    expect(replay.errorCode).toBe('USED_TOKEN');
  });

  it('returns EXPIRED_TOKEN for a token past its expiry', async () => {
    const email = `expired-${randomUUID()}@example.com`;
    const { db, identity } = await seedIdentity(dbUrl, email);
    const { service } = makeService(dbUrl);

    // Mint an already-expired token directly for the seeded identity.
    const { token } = await MagicLinkToken.generate(identity, email, {
      expiresInMinutes: -5,
      db,
    });

    const result = await service.verify(token);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('EXPIRED_TOKEN');
  });
});

describe('MagicLinkTokenCollection lifecycle helpers', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('magic-link-collection');
  });

  it('finds tokens by hash, email, and identity; verifies validity', async () => {
    const email = `mlt-${randomUUID()}@example.com`;
    const { db, identity } = await seedIdentity(dbUrl, email);
    const tokens = await MagicLinkTokenCollection.create({ db });

    const { token, magicLinkToken } = await MagicLinkToken.generate(
      identity,
      email,
      { db },
    );

    expect((await tokens.findByTokenHash(magicLinkToken.tokenHash))?.id).toBe(
      magicLinkToken.id,
    );
    expect(await tokens.findActiveForEmail(email)).toHaveLength(1);
    expect(await tokens.findByIdentity(identity.id as string)).toHaveLength(1);
    expect((await tokens.verify(token))?.id).toBe(magicLinkToken.id);
    expect(await tokens.verify('not-a-real-token')).toBeNull();
  });

  it('counts and rate-limits by IP', async () => {
    const email = `mlt-ip-${randomUUID()}@example.com`;
    const { db, identity } = await seedIdentity(dbUrl, email);
    const tokens = await MagicLinkTokenCollection.create({ db });

    for (let i = 0; i < 3; i++) {
      await MagicLinkToken.generate(identity, email, {
        requestedFromIp: '198.51.100.4',
        db,
      });
    }

    expect(await tokens.countRecentByIp('198.51.100.4', 60)).toBe(3);
    expect(await tokens.isRateLimitedByIp('198.51.100.4', 2)).toBe(true);
    expect(await tokens.isRateLimitedByIp('198.51.100.4', 5)).toBe(false);
  });

  it('cleans up expired/used tokens and revokes tokens for an identity', async () => {
    const email = `mlt-clean-${randomUUID()}@example.com`;
    const { db, identity } = await seedIdentity(dbUrl, email);
    const tokens = await MagicLinkTokenCollection.create({ db });

    // One expired, one active.
    await MagicLinkToken.generate(identity, email, {
      expiresInMinutes: -10,
      db,
    });
    const active = await MagicLinkToken.generate(identity, email, { db });

    expect(await tokens.cleanupExpired()).toBe(1);

    // Revoking marks the still-active token as used.
    const revoked = await tokens.revokeForIdentity(identity.id as string);
    expect(revoked).toBe(1);
    const refetched = await tokens.findByTokenHash(
      active.magicLinkToken.tokenHash,
    );
    expect(refetched?.isUsed()).toBe(true);
  });
});
