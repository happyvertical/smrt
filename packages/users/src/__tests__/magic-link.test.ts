/**
 * Magic link authentication tests
 *
 * Covers JWT signing/verification, nonce replay protection, and cleanup.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsersMagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection.js';
import { UsersMagicLinkToken } from '../models/MagicLinkToken.js';
import {
  MagicLinkError,
  MagicLinkService,
} from '../services/MagicLinkService.js';

describe('MagicLinkService', () => {
  let dbPath: string;
  let service: MagicLinkService;
  let tokens: UsersMagicLinkTokenCollection;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-magic-link-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );

    service = await MagicLinkService.create({
      db: { type: 'sqlite', url: dbPath },
      secret: 'test-secret',
    });

    tokens = await UsersMagicLinkTokenCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  it('uses a package-specific table name for replay protection records', () => {
    const record = new UsersMagicLinkToken();
    expect(record.tableName).toBe('users_magic_link_tokens');
  });

  it('generates and verifies a magic link token', async () => {
    const { token, expiresAt } = await service.generate(' User@Example.com ');

    expect(token).toBeTruthy();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const created = await tokens.list({});
    expect(created).toHaveLength(1);
    expect(created[0]?.email).toBe('user@example.com');
    expect(created[0]?.used).toBe(false);

    const verified = await service.verify(token);

    expect(verified).toEqual({
      email: 'user@example.com',
      nonce: created[0]?.nonce,
    });

    const stored = await tokens.findByNonce(created[0]?.nonce);
    expect(stored?.used).toBe(true);
  });

  it('rejects a token after it has already been used', async () => {
    const { token } = await service.generate('single-use@example.com');

    await expect(service.verify(token)).resolves.toMatchObject({
      email: 'single-use@example.com',
    });

    await expect(service.verify(token)).rejects.toThrow(
      new MagicLinkError('Token has already been used or has expired'),
    );
  });

  it('allows only one concurrent verification to claim the nonce', async () => {
    const { token } = await service.generate('race@example.com');

    const [first, second] = await Promise.allSettled([
      service.verify(token),
      service.verify(token),
    ]);

    const fulfilled = [first, second].filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        email: string;
        nonce: string;
      }> => result.status === 'fulfilled',
    );
    const rejected = [first, second].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]?.value.email).toBe('race@example.com');
    expect(rejected[0]?.reason).toBeInstanceOf(MagicLinkError);
    expect((rejected[0]?.reason as Error).message).toBe(
      'Token has already been used or has expired',
    );
  });

  it('rejects expired JWTs before nonce claim', async () => {
    const shortLived = await MagicLinkService.create({
      db: { type: 'sqlite', url: dbPath },
      secret: 'test-secret',
      tokenExpiry: 1,
    });

    const { token } = await shortLived.generate('expired-jwt@example.com');

    await new Promise((resolve) => setTimeout(resolve, 1500));

    await expect(shortLived.verify(token)).rejects.toThrow(
      new MagicLinkError('Token has expired'),
    );
  });

  it('rejects tokens whose nonce record has expired even if the JWT is still valid', async () => {
    const { token } = await service.generate('expired-record@example.com');

    const created = await tokens.list({});
    expect(created).toHaveLength(1);

    created[0]!.expiresAt = new Date(Date.now() - 1000);
    await created[0]?.save();

    await expect(service.verify(token)).rejects.toThrow(
      new MagicLinkError('Token has already been used or has expired'),
    );
  });

  it('rejects tokens signed with a different secret', async () => {
    const signer = await MagicLinkService.create({
      db: { type: 'sqlite', url: dbPath },
      secret: 'different-secret',
    });

    const { token } = await signer.generate('signature@example.com');

    await expect(service.verify(token)).rejects.toThrow(
      new MagicLinkError('Invalid token'),
    );
  });

  it('rejects tokens from an unexpected issuer', async () => {
    const customIssuerService = await MagicLinkService.create({
      db: { type: 'sqlite', url: dbPath },
      secret: 'test-secret',
      issuer: 'smrt:custom-magiclink',
    });

    const { token } = await customIssuerService.generate('issuer@example.com');

    await expect(service.verify(token)).rejects.toThrow(
      new MagicLinkError('Invalid token'),
    );
  });

  it('cleans up expired replay protection records', async () => {
    await service.generate('expired-cleanup@example.com');
    await service.generate('active-cleanup@example.com');

    const created = await tokens.list({});
    const expired = created.find(
      (record) => record.email === 'expired-cleanup@example.com',
    );

    expect(expired).toBeDefined();

    expired!.expiresAt = new Date(Date.now() - 1000);
    await expired?.save();

    const deleted = await service.cleanupExpiredTokens();
    expect(deleted).toBe(1);

    const remaining = await tokens.list({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.email).toBe('active-cleanup@example.com');
  });
});
