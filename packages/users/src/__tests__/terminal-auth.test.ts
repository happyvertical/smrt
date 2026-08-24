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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersCliAuthApproveLimitCollection } from '../collections/CliAuthApproveLimitCollection.js';
import { UsersCliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
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
  let sessions: SessionCollection;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-terminal-auth-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const tenant = await tenants.create({ id: 'tenant-1', name: 'CLI Tenant' });
    await tenant.save();
    service = await TerminalAuthService.create({
      ...options,
      userCodePrefix: 'WG',
      requestTtlSeconds: 60,
      sessionTtlSeconds: 3600,
      verificationPath: '/terminal-login',
    });
    requests = await UsersCliAuthRequestCollection.create(options);
    sessions = await SessionCollection.create(options);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('retries when a concurrent issuer wins the durable user-code constraint', async () => {
    const existing = await requests.create({
      deviceCodeHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      status: 'pending',
      userCode: 'WG-DEADBEEF',
    });
    await existing.save();
    const internals = service as unknown as {
      makeUserCode: () => string;
      requestCollection: UsersCliAuthRequestCollection;
    };
    vi.spyOn(internals, 'makeUserCode')
      .mockReturnValueOnce('WG-DEADBEEF')
      .mockReturnValueOnce('WG-FEEDBEEF');
    vi.spyOn(internals.requestCollection, 'findByUserCode').mockResolvedValue(
      null,
    );

    const started = await service.createRequest('https://example.com');

    expect(started.userCode).toBe('WG-FEEDBEEF');
    expect(await requests.findByUserCode('WG-FEEDBEEF')).not.toBeNull();
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
    const sessionId = approved.sessionId;
    if (!sessionId) throw new Error('Expected terminal approval session.');

    const token = await service.exchangeDeviceCode(started.deviceCode);
    expect(token.status).toBe('approved');
    if (token.status === 'approved') {
      expect(token.tokenType).toBe('Bearer');
      expect(token.accessToken).toBe(sessionId);
      expect(token.expiresIn).toBe(3600);
    }

    const consumed = await requests.findByUserCode(started.userCode);
    expect(consumed?.status).toBe('consumed');
    expect(consumed?.sessionId).toBeNull();
    expect(await service.exchangeDeviceCode(started.deviceCode)).toEqual({
      status: 'expired',
    });

    const context = await service.loadBearerSession(sessionId);
    expect(context?.user.id).toBe(user.id);
    expect(context?.tenantId).toBe('tenant-1');
  });

  it('allows exactly one concurrent exchange of an approved device code', async () => {
    const user = await users.create({ email: 'concurrent-cli@example.com' });
    await user.save();
    const userId = user.id;
    if (!userId) throw new Error('Expected persisted terminal user.');
    const started = await service.createRequest('https://example.com');
    await service.approveRequest({
      userCode: started.userCode,
      user: { id: userId, email: user.email },
      tenantId: 'tenant-1',
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.exchangeDeviceCode(started.deviceCode),
      ),
    );
    expect(
      results.filter((result) => result.status === 'approved'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'expired'),
    ).toHaveLength(7);
    const stored = await requests.findByUserCode(started.userCode);
    expect(stored?.status).toBe('consumed');
    expect(stored?.sessionId).toBeNull();
  });

  it('reports approval success when token exchange wins the post-commit race', async () => {
    const user = await users.create({
      email: 'approval-exchange-race@example.com',
    });
    await user.save();
    const userId = user.id;
    if (!userId) throw new Error('Expected persisted terminal user.');
    const started = await service.createRequest('https://example.com');
    const originalTransaction = requests.db.transaction?.bind(requests.db);
    if (!originalTransaction) {
      throw new Error('Expected transactional test database.');
    }
    let interceptApprovalCommit = true;
    let exchanged:
      | Awaited<ReturnType<typeof service.exchangeDeviceCode>>
      | undefined;
    requests.db.transaction = async (callback) => {
      const result = await originalTransaction(callback);
      if (interceptApprovalCommit) {
        interceptApprovalCommit = false;
        exchanged = await service.exchangeDeviceCode(started.deviceCode);
      }
      return result;
    };

    const approved = await service.approveRequest({
      userCode: started.userCode,
      user: { id: userId, email: user.email },
      tenantId: 'tenant-1',
    });

    expect(approved.status).toBe('approved');
    expect(approved.sessionId).toBeTruthy();
    expect(exchanged?.status).toBe('approved');
    expect((await requests.findByUserCode(started.userCode))?.status).toBe(
      'consumed',
    );
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

  it('keeps approval idempotent after the CLI already consumed the token', async () => {
    const user = await users.create({ email: 'consumed-approval@example.com' });
    await user.save();
    const userId = user.id;
    if (!userId) throw new Error('Expected persisted terminal user.');
    const started = await service.createRequest('https://example.com');
    await service.approveRequest({
      userCode: started.userCode,
      user: { id: userId, email: user.email },
      tenantId: 'tenant-1',
    });
    expect((await service.exchangeDeviceCode(started.deviceCode)).status).toBe(
      'approved',
    );

    const repeated = await service.approveRequest({
      userCode: started.userCode,
      user: { id: userId, email: user.email },
      tenantId: 'tenant-1',
    });

    expect(repeated.status).toBe('consumed');
    expect(repeated.sessionId).toBeNull();
  });

  it('allows exactly one concurrent approval session to be minted', async () => {
    const user = await users.create({ email: 'approval-race@example.com' });
    await user.save();
    const userId = user.id;
    if (!userId) throw new Error('Expected persisted terminal user.');
    const started = await service.createRequest('https://example.com');

    const approvals = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.approveRequest({
          userCode: started.userCode,
          user: { id: userId, email: user.email },
          tenantId: 'tenant-1',
        }),
      ),
    );

    expect(new Set(approvals.map((approval) => approval.sessionId))).toEqual(
      new Set([approvals[0]?.sessionId]),
    );
    expect(await sessions.findByUser(userId)).toHaveLength(1);
  });

  it('rolls a minted session back when approval persistence fails', async () => {
    const user = await users.create({ email: 'approval-rollback@example.com' });
    await user.save();
    const userId = user.id;
    if (!userId) throw new Error('Expected persisted terminal user.');
    const started = await service.createRequest('https://example.com');
    await requests.db.query(
      `CREATE TRIGGER reject_terminal_approval
       BEFORE UPDATE ON users_cli_auth_requests
       WHEN NEW.status = 'approved'
       BEGIN
         SELECT RAISE(ABORT, 'forced approval persistence failure');
       END`,
    );

    await expect(
      service.approveRequest({
        userCode: started.userCode,
        user: { id: userId, email: user.email },
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow();

    expect(await sessions.findByUser(userId)).toHaveLength(0);
    expect((await requests.findByUserCode(started.userCode))?.status).toBe(
      'pending',
    );
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
    expect(await requests.deleteExpired()).toBe(1);
    expect(await requests.findByUserCode(started.userCode)).toBeNull();

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

    const sessionId = approved.sessionId;
    if (!sessionId) throw new Error('Expected terminal approval session.');
    const before = await service.loadBearerSession(sessionId);
    expect(before?.sessionId).toBe(sessionId);

    const destroyed = await service.destroyBearerSession(sessionId);
    expect(destroyed).toBe(true);

    const after = await service.loadBearerSession(sessionId);
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

  it('does not let a successful approval reset the failed-approve budget', async () => {
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

    // A successful approve must not reset failures in the current window.
    const started = await limited.createRequest('https://example.com');
    await limited.approveRequest({
      userCode: started.userCode,
      user: { id: user.id!, email: user.email },
      tenantId: 'tenant-1',
    });

    await expect(
      limited.approveRequest({
        userCode: 'BOGUS-CODE',
        user: { id: user.id!, email: user.email },
        tenantId: 'tenant-1',
      }),
    ).rejects.toBeInstanceOf(TerminalAuthError);

    // Replaying the known valid code cannot bypass the exhausted budget.
    await expect(
      limited.approveRequest({
        userCode: started.userCode,
        user: { id: user.id!, email: user.email },
        tenantId: 'tenant-1',
      }),
    ).rejects.toBeInstanceOf(TerminalAuthRateLimitError);
  });

  it('enforces the failed-approve budget across parallel attempts', async () => {
    const limited = await TerminalAuthService.create({
      db: { type: 'sqlite', url: dbPath },
      requestTtlSeconds: 60,
      maxApproveAttempts: 3,
      approveAttemptWindowSeconds: 60,
    });
    const secondLimited = await TerminalAuthService.create({
      db: { type: 'sqlite', url: dbPath },
      requestTtlSeconds: 60,
      maxApproveAttempts: 3,
      approveAttemptWindowSeconds: 60,
    });
    const user = await users.create({ email: 'parallel@example.com' });
    await user.save();

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? limited : secondLimited).approveRequest({
          userCode: 'BOGUS-PARALLEL-CODE',
          user: { id: user.id!, email: user.email },
          tenantId: 'tenant-1',
        }),
      ),
    );
    const failures = attempts.map((attempt) =>
      attempt.status === 'rejected' ? attempt.reason : null,
    );

    expect(
      failures.filter((error) => error instanceof TerminalAuthError),
    ).toHaveLength(10);
    expect(
      failures.filter((error) => error instanceof TerminalAuthRateLimitError),
    ).toHaveLength(7);
  });

  it('does not let an old-window release erase a new-window failure', async () => {
    const limits = await UsersCliAuthApproveLimitCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const user = await users.create({ email: 'rollover@example.com' });
    await user.save();
    if (!user.id) throw new Error('Expected persisted rollover user.');

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-23T07:00:00.000Z'));
      const oldWindow = await limits.reserveAttempt({
        maxAttempts: 1,
        userId: user.id,
        windowMs: 1_000,
      });
      expect(oldWindow.allowed).toBe(true);
      if (!oldWindow.allowed) throw new Error('Expected first reservation.');

      vi.advanceTimersByTime(1_001);
      const newWindow = await limits.reserveAttempt({
        maxAttempts: 1,
        userId: user.id,
        windowMs: 1_000,
      });
      expect(newWindow.allowed).toBe(true);

      await limits.releaseAttempt(user.id, oldWindow.windowStartedAt);
      const blocked = await limits.reserveAttempt({
        maxAttempts: 1,
        userId: user.id,
        windowMs: 1_000,
      });
      expect(blocked.allowed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a committed approval when limiter cleanup fails', async () => {
    const user = await users.create({ email: 'cleanup-failure@example.com' });
    await user.save();
    if (!user.id) throw new Error('Expected persisted cleanup-failure user.');
    const started = await service.createRequest('https://example.com');
    const internals = service as unknown as {
      approveLimitCollection: UsersCliAuthApproveLimitCollection;
    };
    vi.spyOn(
      internals.approveLimitCollection,
      'releaseAttempt',
    ).mockRejectedValue(new Error('simulated limiter cleanup outage'));

    const approved = await service.approveRequest({
      userCode: started.userCode,
      user: { id: user.id, email: user.email },
      tenantId: 'tenant-1',
    });

    expect(approved.status).toBe('approved');
    expect(await service.exchangeDeviceCode(started.deviceCode)).toMatchObject({
      status: 'approved',
    });
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
