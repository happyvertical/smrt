/**
 * TerminalAuthService tests — device-code grant lifecycle.
 *
 * Exercises createRequest / approveRequest / exchangeDeviceCode together so
 * we cover the happy path, expiry handling, idempotent approval, and the
 * loadBearerSession path used by hooks.server.ts.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsersCliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { UsersCliAuthRequest } from '../models/CliAuthRequest.js';
import {
  DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS,
  TerminalAuthError,
  TerminalAuthRateLimitError,
  TerminalAuthService,
} from '../services/TerminalAuthService.js';

describe('TerminalAuthService', () => {
  let dbPath: string;
  let service: TerminalAuthService;
  let users: UserCollection;
  let requests: UsersCliAuthRequestCollection;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-terminal-auth-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    service = await TerminalAuthService.create({
      ...options,
      userCodePrefix: 'WG',
      requestTtlSeconds: 60,
      sessionTtlSeconds: 3600,
      verificationPath: '/terminal-login',
    });
    users = await UserCollection.create(options);
    requests = await UsersCliAuthRequestCollection.create(options);
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

  it('uses a package-prefixed table name for cli auth records', () => {
    const record = new UsersCliAuthRequest();
    expect(record.tableName).toBe('users_cli_auth_requests');
  });

  it('issues a request with a prefixed user code and verification url', async () => {
    const result = await service.createRequest('https://example.com');

    expect(result.userCode).toMatch(/^WG-[0-9A-F]{8}$/u);
    expect(result.deviceCode).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(result.deviceCode.length).toBeGreaterThan(30);
    expect(result.interval).toBe(DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS);
    expect(result.verificationUrl).toBe(
      `https://example.com/terminal-login?code=${encodeURIComponent(result.userCode)}`,
    );

    const stored = await requests.findByUserCode(result.userCode);
    expect(stored?.status).toBe('pending');
    expect(stored?.deviceCodeHash).not.toBe(result.deviceCode);
    expect(stored?.deviceCodeHash.length).toBe(64);
  });

  it('approves a pending request and mints a session bound to the user', async () => {
    const user = await users.create({ email: 'cli@example.com' });
    await user.save();

    const started = await service.createRequest('https://example.com');

    const approved = await service.approveRequest({
      userCode: started.userCode,
      user: { id: user.id!, email: user.email },
      tenantId: 'tenant-1',
      ipAddress: '127.0.0.1',
      userAgent: 'cli/1.0',
    });

    expect(approved.status).toBe('approved');
    expect(approved.userId).toBe(user.id);
    expect(approved.tenantId).toBe('tenant-1');
    expect(approved.sessionId).toBeTruthy();

    const token = await service.exchangeDeviceCode(started.deviceCode);
    expect(token.status).toBe('approved');
    if (token.status === 'approved') {
      expect(token.tokenType).toBe('Bearer');
      expect(token.accessToken).toBe(approved.sessionId);
      expect(token.expiresIn).toBe(3600);
    }

    const context = await service.loadBearerSession(approved.sessionId);
    expect(context?.user.id).toBe(user.id);
    expect(context?.tenantId).toBe('tenant-1');
  });

  it('keeps approval idempotent — re-approving a request is a no-op', async () => {
    const user = await users.create({ email: 'cli@example.com' });
    await user.save();
    const started = await service.createRequest('https://example.com');

    const first = await service.approveRequest({
      userCode: started.userCode,
      user: { id: user.id!, email: user.email },
      tenantId: 'tenant-1',
    });
    const second = await service.approveRequest({
      userCode: started.userCode,
      user: { id: user.id!, email: user.email },
      tenantId: 'tenant-1',
    });

    expect(second.sessionId).toBe(first.sessionId);
  });

  it('rejects approval without an authenticated user/tenant', async () => {
    const started = await service.createRequest('https://example.com');

    await expect(
      service.approveRequest({
        userCode: started.userCode,
        user: { id: '', email: '' },
        tenantId: 'tenant-1',
      }),
    ).rejects.toBeInstanceOf(TerminalAuthError);

    await expect(
      service.approveRequest({
        userCode: started.userCode,
        user: { id: 'user-1', email: 'u@example.com' },
        tenantId: undefined,
      }),
    ).rejects.toBeInstanceOf(TerminalAuthError);
  });

  it('expires a pending request once its TTL has passed', async () => {
    const started = await service.createRequest('https://example.com');

    const stored = await requests.findByUserCode(started.userCode);
    stored!.expiresAt = new Date(Date.now() - 1000);
    await stored?.save();

    const lookup = await service.getRequestForUserCode(started.userCode);
    expect(lookup?.status).toBe('expired');

    const tokenResult = await service.exchangeDeviceCode(started.deviceCode);
    expect(tokenResult.status).toBe('expired');
  });

  it('reports pending while a request is still waiting for approval', async () => {
    const started = await service.createRequest('https://example.com');

    const tokenResult = await service.exchangeDeviceCode(started.deviceCode);
    expect(tokenResult.status).toBe('pending');
    if (tokenResult.status === 'pending') {
      expect(tokenResult.interval).toBe(DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS);
      expect(new Date(tokenResult.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
    }
  });

  it('returns expired for an unknown device code without leaking validity', async () => {
    const result = await service.exchangeDeviceCode('not-a-real-device-code');
    expect(result.status).toBe('expired');
  });

  it('revokes a bearer session on destroy', async () => {
    const user = await users.create({ email: 'cli@example.com' });
    await user.save();
    const started = await service.createRequest('https://example.com');
    const approved = await service.approveRequest({
      userCode: started.userCode,
      user: { id: user.id!, email: user.email },
      tenantId: 'tenant-1',
    });

    const before = await service.loadBearerSession(approved.sessionId);
    expect(before?.sessionId).toBe(approved.sessionId);

    const destroyed = await service.destroyBearerSession(approved.sessionId);
    expect(destroyed).toBe(true);

    const after = await service.loadBearerSession(approved.sessionId);
    expect(after).toBeNull();
  });

  it('makes user codes without a prefix when none is configured', async () => {
    const unprefixed = await TerminalAuthService.create({
      db: { type: 'sqlite', url: dbPath },
      requestTtlSeconds: 60,
    });
    const started = await unprefixed.createRequest('https://example.com');
    expect(started.userCode).toMatch(/^[0-9A-F]{8}$/u);
  });

  it('locks an authenticated user out after exceeding the failed-approve budget', async () => {
    const limited = await TerminalAuthService.create({
      db: { type: 'sqlite', url: dbPath },
      requestTtlSeconds: 60,
      maxApproveAttempts: 3,
      approveAttemptWindowSeconds: 60,
    });
    const user = await users.create({ email: 'attacker@example.com' });
    await user.save();

    const fail = async () => {
      await limited.approveRequest({
        userCode: 'BOGUS-CODE-XXX',
        user: { id: user.id!, email: user.email },
        tenantId: 'tenant-1',
      });
    };

    for (let i = 0; i < 3; i++) {
      await expect(fail()).rejects.toBeInstanceOf(TerminalAuthError);
    }

    // 4th attempt must surface the rate-limit error, even for a *valid* code.
    const real = await limited.createRequest('https://example.com');
    await expect(
      limited.approveRequest({
        userCode: real.userCode,
        user: { id: user.id!, email: user.email },
        tenantId: 'tenant-1',
      }),
    ).rejects.toBeInstanceOf(TerminalAuthRateLimitError);

    try {
      await limited.approveRequest({
        userCode: real.userCode,
        user: { id: user.id!, email: user.email },
        tenantId: 'tenant-1',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalAuthRateLimitError);
      const rateError = error as TerminalAuthRateLimitError;
      expect(rateError.retryAfterSeconds).toBeGreaterThan(0);
      expect(rateError.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('resets the failed-approve counter after a successful approval', async () => {
    const limited = await TerminalAuthService.create({
      db: { type: 'sqlite', url: dbPath },
      requestTtlSeconds: 60,
      maxApproveAttempts: 3,
      approveAttemptWindowSeconds: 60,
    });
    const user = await users.create({ email: 'cli@example.com' });
    await user.save();

    // Burn 2 failed attempts (one short of the cap).
    for (let i = 0; i < 2; i++) {
      await expect(
        limited.approveRequest({
          userCode: 'BOGUS-CODE',
          user: { id: user.id!, email: user.email },
          tenantId: 'tenant-1',
        }),
      ).rejects.toBeInstanceOf(TerminalAuthError);
    }

    // Successful approve resets the counter.
    const started = await limited.createRequest('https://example.com');
    await limited.approveRequest({
      userCode: started.userCode,
      user: { id: user.id!, email: user.email },
      tenantId: 'tenant-1',
    });

    // 3 more failures should now all be plain TerminalAuthError, not
    // TerminalAuthRateLimitError — the counter was reset.
    for (let i = 0; i < 3; i++) {
      try {
        await limited.approveRequest({
          userCode: 'BOGUS-CODE',
          user: { id: user.id!, email: user.email },
          tenantId: 'tenant-1',
        });
        throw new Error('expected approveRequest to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(TerminalAuthError);
        expect(error).not.toBeInstanceOf(TerminalAuthRateLimitError);
      }
    }
  });

  it('lets the rate-limit window expire and accepts attempts again', async () => {
    const limited = await TerminalAuthService.create({
      db: { type: 'sqlite', url: dbPath },
      requestTtlSeconds: 60,
      maxApproveAttempts: 2,
      approveAttemptWindowSeconds: 1,
    });
    const user = await users.create({ email: 'cli@example.com' });
    await user.save();

    for (let i = 0; i < 2; i++) {
      await expect(
        limited.approveRequest({
          userCode: 'BOGUS-CODE',
          user: { id: user.id!, email: user.email },
          tenantId: 'tenant-1',
        }),
      ).rejects.toBeInstanceOf(TerminalAuthError);
    }

    // Locked out immediately after the cap.
    await expect(
      limited.approveRequest({
        userCode: 'BOGUS-CODE',
        user: { id: user.id!, email: user.email },
        tenantId: 'tenant-1',
      }),
    ).rejects.toBeInstanceOf(TerminalAuthRateLimitError);

    // After the window, the lock lifts.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const started = await limited.createRequest('https://example.com');
    const approved = await limited.approveRequest({
      userCode: started.userCode,
      user: { id: user.id!, email: user.email },
      tenantId: 'tenant-1',
    });
    expect(approved.status).toBe('approved');
  });
});
