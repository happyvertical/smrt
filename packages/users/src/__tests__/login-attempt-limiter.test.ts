/**
 * LoginAttemptLimiter (#3273) — shared budget, two-key semantics, exponential
 * lockout, non-enumeration, and the audit seam.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersLoginAttemptCollection } from '../collections/LoginAttemptCollection.js';
import { UsersLoginAuditEventCollection } from '../collections/LoginAuditEventCollection.js';
import { UsersLoginAttempt } from '../models/LoginAttempt.js';
import { UsersLoginAuditEvent } from '../models/LoginAuditEvent.js';
import {
  type LoginAttemptLease,
  LoginAttemptLimiter,
  type LoginAuditEntry,
  LoginRateLimitError,
} from '../services/LoginAttemptLimiter.js';

function expectAllowed(
  decision: Awaited<ReturnType<LoginAttemptLimiter['reserve']>>,
): LoginAttemptLease {
  if (!decision.allowed) {
    throw new Error(
      `Expected an allowed reservation, got retryAfter=${decision.retryAfterSeconds}`,
    );
  }
  return decision;
}

describe('LoginAttemptLimiter', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `smrt-login-limiter-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it.each([
    'subject',
    'source',
  ] as const)('reports the actual earliest reserved %s window deadline', async (short) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = Date.parse('2026-10-29T18:00:00.000Z');
    vi.setSystemTime(started);
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      subject: { windowSeconds: short === 'subject' ? 1 : 100 },
      source: { windowSeconds: short === 'source' ? 1 : 100 },
    });
    const first = expectAllowed(
      await limiter.reserve({
        kind: 'deadline',
        subject: 'first',
        source: 'first',
        retainOnSuccess: true,
      }),
    );
    expect(first.budgetExpiresAt).toBe(started + 1000);
    await first.succeed();
    vi.setSystemTime(started + 900);
    const second = expectAllowed(
      await limiter.reserve({
        kind: 'deadline',
        subject: short === 'subject' ? 'first' : 'second',
        source: short === 'source' ? 'first' : 'second',
        retainOnSuccess: true,
      }),
    );
    expect(second.budgetExpiresAt).toBe(started + 1000);
    await second.succeed();
  });

  it('uses package-prefixed, change-feed-sensitive tables', () => {
    expect(new UsersLoginAttempt().tableName).toBe('users_login_attempts');
    expect(new UsersLoginAuditEvent().tableName).toBe(
      'users_login_audit_events',
    );
  });

  it('allows maxAttempts failures per subject and then refuses with Retry-After', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 3,
      windowSeconds: 60,
    });

    for (let i = 0; i < 3; i++) {
      const lease = expectAllowed(
        await limiter.reserve({ kind: 'password', subject: 'a@example.com' }),
      );
      await lease.fail();
    }

    const refused = await limiter.reserve({
      kind: 'password',
      subject: 'a@example.com',
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.scope).toBe('subject');
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(() => {
        throw new LoginRateLimitError(refused);
      }).toThrow(LoginRateLimitError);
    }

    // A different subject from the same (absent) source is unaffected.
    const other = await limiter.reserve({
      kind: 'password',
      subject: 'b@example.com',
    });
    expect(other.allowed).toBe(true);
  });

  it('normalizes subject keys so case and whitespace cannot dodge the budget', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 2,
      lockout: false,
    });
    await expectAllowed(
      await limiter.reserve({ kind: 'password', subject: 'Case@Example.com' }),
    ).fail();
    await expectAllowed(
      await limiter.reserve({
        kind: 'password',
        subject: ' case@example.com ',
      }),
    ).fail();
    const refused = await limiter.reserve({
      kind: 'password',
      subject: 'CASE@EXAMPLE.COM',
    });
    expect(refused.allowed).toBe(false);
  });

  it('refuses on the source budget and hands back the subject reservation', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 2,
      lockout: false,
    });
    // Burn the source budget across two different subjects.
    await expectAllowed(
      await limiter.reserve({
        kind: 'password',
        subject: 'u1',
        source: '10.0.0.1',
      }),
    ).fail();
    await expectAllowed(
      await limiter.reserve({
        kind: 'password',
        subject: 'u2',
        source: '10.0.0.1',
      }),
    ).fail();

    const refused = await limiter.reserve({
      kind: 'password',
      subject: 'u3',
      source: '10.0.0.1',
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.scope).toBe('source');

    // u3's own budget was not consumed by the refused attempt.
    const fromElsewhere = await limiter.reserve({
      kind: 'password',
      subject: 'u3',
      source: '10.0.0.2',
    });
    expect(fromElsewhere.allowed).toBe(true);
    const attempts = await UsersLoginAttemptCollection.create(options);
    const u3 = await attempts.list({
      where: { limiterKey: limiter.hashKey('subject', 'u3') },
    });
    expect(u3[0]?.attemptCount).toBe(1);
  });

  it('does not refill in-window failures on success, but does reset the streak', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 3,
      windowSeconds: 60,
    });
    await expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 's' }),
    ).fail();
    await expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 's' }),
    ).fail();
    await expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 's' }),
    ).succeed();

    // Two failures remain in the window; the third exhausts it.
    const third = expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 's' }),
    );
    const outcome = await third.fail();
    expect(outcome.lockedOut).toBe(true);
    const refused = await limiter.reserve({ kind: 'k', subject: 's' });
    expect(refused.allowed).toBe(false);

    const attempts = await UsersLoginAttemptCollection.create(options);
    const [row] = await attempts.list({
      where: { limiterKey: limiter.hashKey('subject', 's') },
    });
    // Streak counts only failures since the last success.
    expect(row?.failureStreak).toBe(1);
  });

  it('releases a reservation whose credential work never ran', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 1,
      lockout: false,
    });
    await expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 's' }),
    ).release();
    expect((await limiter.reserve({ kind: 'k', subject: 's' })).allowed).toBe(
      true,
    );
  });

  it('locks out with exponential backoff across consecutive exhausted budgets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 2,
      windowSeconds: 10,
      lockout: { baseSeconds: 30, factor: 2, maxSeconds: 100 },
      streakResetSeconds: 10_000,
    });
    const exhaust = async () => {
      let last: Awaited<ReturnType<LoginAttemptLease['fail']>> | null = null;
      for (let i = 0; i < 2; i++) {
        last = await expectAllowed(
          await limiter.reserve({ kind: 'pin', subject: 'u' }),
        ).fail();
      }
      return last;
    };

    const first = await exhaust();
    expect(first?.lockedOut).toBe(true);
    expect(first?.retryAfterSeconds).toBe(30);

    // Still locked after the window would have expired.
    vi.advanceTimersByTime(15_000);
    const stillLocked = await limiter.reserve({ kind: 'pin', subject: 'u' });
    expect(stillLocked.allowed).toBe(false);
    if (!stillLocked.allowed) expect(stillLocked.lockedOut).toBe(true);

    vi.advanceTimersByTime(16_000); // past the 30s lockout
    const second = await exhaust();
    expect(second?.retryAfterSeconds).toBe(60);

    vi.advanceTimersByTime(61_000);
    const third = await exhaust();
    expect(third?.retryAfterSeconds).toBe(100); // capped

    // A success forgives the streak: the next lockout is back to base.
    vi.advanceTimersByTime(101_000);
    await expectAllowed(
      await limiter.reserve({ kind: 'pin', subject: 'u' }),
    ).succeed();
    vi.advanceTimersByTime(11_000);
    const afterSuccess = await exhaust();
    expect(afterSuccess?.retryAfterSeconds).toBe(30);
  });

  it('locks out a client that paces itself one attempt under the window budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 3,
      windowSeconds: 10,
      lockout: { baseSeconds: 30, factor: 2, maxSeconds: 100 },
      streakResetSeconds: 10_000,
    });
    const failOnce = async () =>
      expectAllowed(
        await limiter.reserve({ kind: 'pin', subject: 'u' }),
      ).fail();

    // Two failures, then wait out the window: no window is ever exhausted.
    expect((await failOnce()).lockedOut).toBe(false);
    expect((await failOnce()).lockedOut).toBe(false);
    vi.advanceTimersByTime(11_000);
    // The third consecutive failure still locks the key.
    const third = await failOnce();
    expect(third.lockedOut).toBe(true);
    expect(third.retryAfterSeconds).toBe(30);
    const refused = await limiter.reserve({ kind: 'pin', subject: 'u' });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.lockedOut).toBe(true);

    // And the backoff keeps escalating across paced rounds.
    vi.advanceTimersByTime(31_000);
    await failOnce();
    await failOnce();
    vi.advanceTimersByTime(11_000);
    expect((await failOnce()).retryAfterSeconds).toBe(60);
  });

  it('keeps a shared source’s backoff when someone signs in successfully', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 2,
      windowSeconds: 10,
      lockout: { baseSeconds: 30, factor: 2, maxSeconds: 1000 },
      streakResetSeconds: 600,
      sourceStreakDecaySeconds: 600,
    });
    let victim = 0;
    const guess = async () =>
      expectAllowed(
        await limiter.reserve({
          kind: 'pin',
          subject: `victim-${victim++}`,
          source: 'tablet-1',
        }),
      ).fail();

    await guess();
    expect((await guess()).retryAfterSeconds).toBe(30);
    vi.advanceTimersByTime(31_000);

    // An insider's own valid sign-in resets their subject, not the tablet.
    await expectAllowed(
      await limiter.reserve({
        kind: 'pin',
        subject: 'insider',
        source: 'tablet-1',
      }),
    ).succeed();
    await guess();
    expect((await guess()).retryAfterSeconds).toBe(60);

    // The tablet's history decays by time since its last failure, even
    // though it stays in use the whole time.
    for (let i = 0; i < 7; i++) {
      vi.advanceTimersByTime(100_000);
      await expectAllowed(
        await limiter.reserve({
          kind: 'pin',
          subject: 'insider',
          source: 'tablet-1',
        }),
      ).succeed();
    }
    await guess();
    expect((await guess()).retryAfterSeconds).toBe(30);
  });

  it('sheds a shared source’s failures gradually, so spaced-out typos never lock it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 3,
      windowSeconds: 60,
      lockout: { baseSeconds: 30, factor: 2, maxSeconds: 1000 },
      streakResetSeconds: 100_000,
      sourceStreakDecaySeconds: 120,
    });
    let person = 0;
    const typo = async () =>
      expectAllowed(
        await limiter.reserve({
          kind: 'pin',
          subject: `person-${person++}`,
          source: 'tablet-1',
        }),
      ).fail();

    // A typo every five minutes, all day, on a tablet that never goes quiet
    // for the full streak horizon: each gap forgives the previous one.
    for (let i = 0; i < 12; i++) {
      expect((await typo()).lockedOut).toBe(false);
      vi.advanceTimersByTime(300_000);
    }

    // A burst leaves no time to decay: it locks, and keeps escalating.
    await typo();
    await typo();
    const first = await typo();
    expect(first.lockedOut).toBe(true);
    expect(first.retryAfterSeconds).toBe(30);
    vi.advanceTimersByTime(31_000);
    await typo();
    await typo();
    expect((await typo()).retryAfterSeconds).toBe(60);

    // Resting on a boundary is not crossing it: one typo an interval later
    // forgives one and adds one, and must not re-lock everyone.
    vi.advanceTimersByTime(130_000);
    expect((await typo()).lockedOut).toBe(false);

    // Partial decay: four minutes forgives two of the six, not all of them.
    vi.advanceTimersByTime(240_000);
    await typo();
    expect((await typo()).retryAfterSeconds).toBe(60);
  });

  it('applies a source’s forgiveness once when failures land concurrently', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const attempts = await UsersLoginAttemptCollection.create(options);
    const key = 'source-key-under-test';
    const reserve = () =>
      attempts.reserveAttempt({
        limiterKey: key,
        scope: 'source',
        maxAttempts: 50,
        windowMs: 3_600_000,
        streakResetMs: 86_400_000,
        retainMs: 86_400_000,
      });
    const fail = () =>
      attempts.recordFailure({
        limiterKey: key,
        maxAttempts: 50,
        retainMs: 86_400_000,
        streakDecayMs: 600_000,
        lockoutMsFor: () => 0,
      });
    const streak = async () =>
      Number(
        (
          await attempts.db.query(
            `SELECT failure_streak FROM ${attempts.tableName} WHERE limiter_key = ?`,
            key,
          )
        ).rows?.[0]?.failure_streak,
      );

    for (let i = 0; i < 4; i++) {
      await reserve();
      await fail();
    }
    expect(await streak()).toBe(4);

    // One decay interval later, four failures arrive at once. Forgiving one
    // and adding one writes the same number back, so a guard on the streak
    // alone would let all four apply the forgiveness: 4 again, not 7.
    vi.advanceTimersByTime(600_000);
    for (let i = 0; i < 4; i++) await reserve();
    await Promise.all([fail(), fail(), fail(), fail()]);
    expect(await streak()).toBe(7);
  });

  it('does not decay a subject’s streak, and honours a disabled source decay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 3,
      windowSeconds: 10,
      lockout: { baseSeconds: 30, factor: 2, maxSeconds: 1000 },
      streakResetSeconds: 100_000,
      sourceStreakDecaySeconds: 0,
    });
    for (const key of [{ subject: 'victim' }, { source: 'tablet-1' }]) {
      const fail = async () =>
        expectAllowed(await limiter.reserve({ kind: 'pin', ...key })).fail();
      await fail();
      vi.advanceTimersByTime(300_000);
      await fail();
      vi.advanceTimersByTime(300_000);
      // The third failure, however far apart, completes the streak.
      expect((await fail()).lockedOut).toBe(true);
    }
  });

  it('makes an applied lockout the sole gate: once it elapses the window rolls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 2,
      windowSeconds: 300,
      lockout: { baseSeconds: 5, factor: 2, maxSeconds: 5 },
    });
    for (let i = 0; i < 2; i++) {
      await expectAllowed(
        await limiter.reserve({ kind: 'k', subject: 's' }),
      ).fail();
    }
    const denied = await limiter.reserve({ kind: 'k', subject: 's' });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.lockedOut).toBe(true);
      // Reports the lockout, not the (much longer) window remainder.
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(5);
    }
    vi.advanceTimersByTime(6_000);
    expect((await limiter.reserve({ kind: 'k', subject: 's' })).allowed).toBe(
      true,
    );
  });

  it('refuses to hand out a lease that limits nothing', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
    });
    await expect(
      limiter.reserve({ kind: 'k', subject: '  ', source: '' }),
    ).rejects.toThrow(/needs a subject or a source key/u);
  });

  it('enforces the budget across parallel reservations', async () => {
    // The database row is the arbiter; the limiter keeps no in-process state,
    // so parallel reservations cannot all pass the check before any one of
    // them is recorded. The Postgres variant runs this across two instances.
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 3,
    });
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.reserve({ kind: 'k', subject: 'parallel', source: '1.1.1.1' }),
      ),
    );
    const allowed = decisions.filter((d) => d.allowed);
    expect(allowed).toHaveLength(3);
    for (const lease of allowed) {
      if (lease.allowed) await lease.fail();
    }
    expect(
      (await limiter.reserve({ kind: 'k', subject: 'parallel' })).allowed,
    ).toBe(false);
  });

  it('treats an unknown subject exactly like a known one', async () => {
    // The limiter keys on what was submitted, so there is no "unknown" path:
    // the same identifier always maps to the same row, account or not.
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 1,
      lockout: false,
    });
    await expectAllowed(
      await limiter.reserve({
        kind: 'password',
        subject: 'nobody@example.com',
      }),
    ).fail();
    const refused = await limiter.reserve({
      kind: 'password',
      subject: 'nobody@example.com',
    });
    expect(refused.allowed).toBe(false);
    expect(limiter.hashKey('subject', 'nobody@example.com')).not.toContain(
      'nobody',
    );
  });

  it('records every decision through the durable default audit sink', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      maxAttempts: 1,
      lockout: { baseSeconds: 5 },
    });
    await expectAllowed(
      await limiter.reserve({ kind: 'pin', subject: 'u', source: 'device-1' }),
    ).fail();
    await limiter.reserve({ kind: 'pin', subject: 'u', source: 'device-1' });
    await limiter.recordManagement({
      kind: 'pin',
      subject: 'u',
      metadata: { action: 'set' },
    });

    const events = await UsersLoginAuditEventCollection.create(options);
    const rows = await events.list({});
    const byOutcome = (outcome: string) =>
      rows.find((row) => row.outcome === outcome);
    expect(rows.map((row) => row.outcome).sort()).toEqual([
      'denied',
      'locked',
      'managed',
      // The failure also started the device's source lockout (#3531).
      'source-locked',
    ]);
    expect(byOutcome('source-locked')?.subjectKeyHash).toBeNull();
    expect(byOutcome('locked')?.subjectKeyHash).toBe(
      limiter.hashKey('subject', 'u'),
    );
    expect(byOutcome('locked')?.sourceKeyHash).toBe(
      limiter.hashKey('source', 'device-1'),
    );
    expect(byOutcome('denied')?.retryAfterSeconds).toBeGreaterThan(0);
    expect(byOutcome('managed')?.getMetadata()).toEqual({ action: 'set' });
    // Nothing raw ever lands in the row.
    expect(JSON.stringify(rows)).not.toContain('device-1');
  });

  it('forwards to a custom sink and survives a sink that throws', async () => {
    const seen: LoginAuditEntry[] = [];
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      maxAttempts: 2,
      audit: {
        record: async (entry) => {
          seen.push(entry);
          throw new Error('sink down');
        },
      },
    });
    await expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 's' }),
    ).succeed();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.outcome).toBe('succeeded');
    const events = await UsersLoginAuditEventCollection.create(options);
    expect(await events.list({})).toHaveLength(0);
  });

  describe('independent subject and source budgets (#3531)', () => {
    it('keeps a strict per-account budget with a larger per-address one', async () => {
      const limiter = await LoginAttemptLimiter.create({
        ...options,
        audit: false,
        subject: { maxFailures: 2, lockout: { baseSeconds: 60 } },
        source: { maxFailures: 6, lockout: false },
      });
      const attempt = (subject: string) =>
        limiter.reserve({ kind: 'password', subject, source: 'proxy' });
      for (let i = 0; i < 2; i++) {
        const outcome = await expectAllowed(
          await attempt('a@example.com'),
        ).fail();
        if (i === 1) expect(outcome.lockedOut).toBe(true);
      }
      const account = await attempt('a@example.com');
      expect(account.allowed).toBe(false);
      if (!account.allowed) {
        expect(account.scope).toBe('subject');
        expect(account.lockedOut).toBe(true);
      }
      // Other people behind the same address still have the address budget.
      for (const subject of ['b@example.com', 'c@example.com']) {
        await expectAllowed(await attempt(subject)).fail();
        await expectAllowed(await attempt(subject)).fail();
      }
      const address = await attempt('d@example.com');
      expect(address.allowed).toBe(false);
      // The source budget has no lockout: only its window refuses.
      if (!address.allowed) {
        expect(address.scope).toBe('source');
        expect(address.lockedOut).toBe(false);
      }
    });

    it('keeps today’s shared defaults when no budget is configured', async () => {
      const limiter = await LoginAttemptLimiter.create({
        ...options,
        audit: false,
        maxAttempts: 2,
        lockout: false,
      });
      expect(limiter.limitsSource).toBe(true);
      await expectAllowed(
        await limiter.reserve({ kind: 'p', subject: 'x', source: 'ip' }),
      ).fail();
      await expectAllowed(
        await limiter.reserve({ kind: 'p', subject: 'y', source: 'ip' }),
      ).fail();
      const refused = await limiter.reserve({
        kind: 'p',
        subject: 'z',
        source: 'ip',
      });
      expect(refused.allowed).toBe(false);
      if (!refused.allowed) expect(refused.scope).toBe('source');
    });

    it('ignores the address entirely with source: false, and fails closed without a subject', async () => {
      const limiter = await LoginAttemptLimiter.create({
        ...options,
        audit: false,
        maxAttempts: 2,
        source: false,
      });
      expect(limiter.limitsSource).toBe(false);
      for (let i = 0; i < 10; i++) {
        await expectAllowed(
          await limiter.reserve({
            kind: 'password',
            subject: `user-${i}`,
            source: 'shared-proxy',
          }),
        ).fail();
      }
      const attempts = await UsersLoginAttemptCollection.create(options);
      expect(
        await attempts.list({
          where: { limiterKey: limiter.hashKey('source', 'shared-proxy') },
        }),
      ).toEqual([]);
      await expect(
        limiter.reserve({ kind: 'password', source: 'shared-proxy' }),
      ).rejects.toThrow('source budget is disabled');
      // The account budget still applies.
      await expectAllowed(
        await limiter.reserve({ kind: 'password', subject: 'user-0' }),
      ).fail();
      expect(
        (await limiter.reserve({ kind: 'password', subject: 'user-0' }))
          .allowed,
      ).toBe(false);
    });

    it('audits a source lockout once, without the attempted accounts, rate limited per source', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
      const seen: LoginAuditEntry[] = [];
      const limiter = await LoginAttemptLimiter.create({
        ...options,
        audit: { record: async (entry) => void seen.push(entry) },
        subject: { maxFailures: 10 },
        source: { maxFailures: 2, lockout: { baseSeconds: 30 } },
        sourceStreakDecaySeconds: 0,
        sourceLockoutAuditSeconds: 600,
      });
      const burst = async () => {
        for (const subject of [
          'victim-1@example.com',
          'victim-2@example.com',
        ]) {
          await expectAllowed(
            await limiter.reserve({
              kind: 'password',
              subject,
              source: '203.0.113.9',
              metadata: { tenantId: 'tenant-1' },
            }),
          ).fail();
        }
      };
      const sourceLocked = () =>
        seen.filter((entry) => entry.outcome === 'source-locked');

      await burst();
      expect(sourceLocked()).toHaveLength(1);
      const [entry] = sourceLocked();
      expect(entry.subjectKeyHash).toBeNull();
      expect(entry.sourceKeyHash).toBe(
        limiter.hashKey('source', '203.0.113.9'),
      );
      expect(entry.metadata).toEqual({ scope: 'source' });
      expect(entry.retryAfterSeconds).toBe(30);
      expect(JSON.stringify(entry)).not.toContain('victim');
      expect(JSON.stringify(entry)).not.toContain(
        limiter.hashKey('subject', 'victim-1@example.com'),
      );

      // A second lockout inside the audit interval is not reported again.
      vi.advanceTimersByTime(31_000);
      await burst();
      expect(sourceLocked()).toHaveLength(1);

      // After the interval the next lockout start is reported.
      vi.advanceTimersByTime(601_000);
      await burst();
      expect(sourceLocked()).toHaveLength(2);

      // A subject-only lockout never produces a source entry.
      const subjectOnly = await LoginAttemptLimiter.create({
        ...options,
        audit: { record: async (e) => void seen.push(e) },
        maxAttempts: 1,
        source: false,
      });
      await expectAllowed(
        await subjectOnly.reserve({
          kind: 'password',
          subject: 'solo',
          source: '203.0.113.10',
        }),
      ).fail();
      expect(sourceLocked()).toHaveLength(2);
    });
  });

  it('refuses to settle a lease twice', async () => {
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
    });
    const lease = expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 's' }),
    );
    await lease.succeed();
    await expect(lease.fail()).rejects.toThrow(/already settled/u);
  });

  it('prunes idle rows but keeps live windows and lockouts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const limiter = await LoginAttemptLimiter.create({
      ...options,
      audit: false,
      maxAttempts: 1,
      windowSeconds: 10,
      lockout: { baseSeconds: 1000 },
      streakResetSeconds: 50,
    });
    await expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 'locked' }),
    ).fail();
    const open = expectAllowed(
      await limiter.reserve({ kind: 'k', subject: 'live' }),
    );
    vi.advanceTimersByTime(60_000);
    // 'locked' is still locked out (1000s); 'live' is idle past 50s.
    expect(await limiter.cleanupIdle({ dryRun: true })).toBe(1);
    expect(await limiter.cleanupIdle()).toBe(1);
    expect(
      (await limiter.reserve({ kind: 'k', subject: 'locked' })).allowed,
    ).toBe(false);
    await open.release();
  });
});
