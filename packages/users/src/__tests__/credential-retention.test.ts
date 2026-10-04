/**
 * Tests for credential retention (issue #2375, assessment finding F2).
 *
 * `deleteExpired()` existed on sessions, magic-link tokens and CLI auth
 * requests, and every one of them waited for an application to call it. These
 * cover the dry-run previews the retention sweep needs, the tasks that
 * contribute the three prunes to that sweep, and the `expires_at` index each
 * predicate depends on.
 *
 * Real file-backed SQLite (matching the rest of this package's suite); no
 * mocking.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRetentionTasks,
  runRetentionSweep,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersCliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { UsersLoginAttemptCollection } from '../collections/LoginAttemptCollection.js';
import { UsersLoginAuditEventCollection } from '../collections/LoginAuditEventCollection.js';
import { UsersMagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  CLI_AUTH_RETENTION_TASK,
  DEFAULT_LOGIN_AUDIT_RETENTION_DAYS,
  LOGIN_ATTEMPTS_RETENTION_TASK,
  LOGIN_AUDIT_RETENTION_TASK,
  MAGIC_LINK_RETENTION_TASK,
  registerUserRetentionTasks,
  SESSIONS_RETENTION_TASK,
  unregisterUserRetentionTasks,
} from '../retention.js';
import { LoginAttemptLimiter } from '../services/LoginAttemptLimiter.js';
import { SessionStatus } from '../types/index.js';

const MINUTE_MS = 60 * 1000;

let dbPath: string;
let sessions: SessionCollection;
let users: UserCollection;
let tokens: UsersMagicLinkTokenCollection;
let requests: UsersCliAuthRequestCollection;
let db: DatabaseInterface;

beforeEach(async () => {
  clearRetentionTasks();
  dbPath = join(tmpdir(), `smrt-credential-retention-${Date.now()}.db`);
  const options = { db: { type: 'sqlite' as const, url: dbPath } };

  users = await UserCollection.create(options);
  await TenantCollection.create(options);
  sessions = await SessionCollection.create(options);
  tokens = await UsersMagicLinkTokenCollection.create(options);
  requests = await UsersCliAuthRequestCollection.create(options);
  db = sessions.db;
});

afterEach(() => {
  clearRetentionTasks();
  if (existsSync(dbPath)) {
    try {
      rmSync(dbPath, { force: true });
    } catch (error) {
      console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, error);
    }
  }
});

async function seedSession(options: {
  userId: string;
  expiresAt: Date;
  status?: SessionStatus;
}): Promise<void> {
  const user = await users.create({
    id: options.userId,
    email: `${options.userId}@retention.test`,
  });
  await user.save();
  const session = await sessions.create({
    userId: options.userId,
    expiresAt: options.expiresAt,
    status: options.status ?? SessionStatus.ACTIVE,
  });
  await session.save();
}

async function countRows(table: string): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(result.rows[0]?.total ?? 0);
}

describe('deleteExpired dry runs (#2375)', () => {
  it('counts expired sessions without deleting them', async () => {
    await seedSession({
      userId: 'user-expired',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    await seedSession({
      userId: 'user-live',
      expiresAt: new Date(Date.now() + 60 * MINUTE_MS),
    });

    expect(await sessions.deleteExpired({ dryRun: true })).toBe(1);
    expect(await countRows('sessions')).toBe(2);

    expect(await sessions.deleteExpired()).toBe(1);
    expect(await countRows('sessions')).toBe(1);
  });

  it('counts expired magic-link tokens without deleting them', async () => {
    const token = await tokens.create({
      nonce: 'nonce-expired',
      email: 'a@example.com',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    await token.save();

    expect(await tokens.deleteExpired({ dryRun: true })).toBe(1);
    expect(await countRows('users_magic_link_tokens')).toBe(1);

    expect(await tokens.deleteExpired()).toBe(1);
    expect(await countRows('users_magic_link_tokens')).toBe(0);
  });

  it('counts expired CLI auth requests without deleting them', async () => {
    const request = await requests.create({
      userCode: 'ABCD-EFGH',
      deviceCodeHash: 'hash-1',
      status: 'pending',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    await request.save();

    expect(await requests.deleteExpired({ dryRun: true })).toBe(1);
    expect(await countRows('users_cli_auth_requests')).toBe(1);

    expect(await requests.deleteExpired()).toBe(1);
    expect(await countRows('users_cli_auth_requests')).toBe(0);
  });

  it('reaps consumed CLI auth requests after their approval window', async () => {
    const request = await requests.create({
      userCode: 'USED-CODE',
      deviceCodeHash: 'hash-consumed',
      status: 'consumed',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    await request.save();

    expect(await requests.deleteExpired()).toBe(1);
    expect(await countRows('users_cli_auth_requests')).toBe(0);
  });

  it('reaps requests already marked expired by lazy expiry', async () => {
    const request = await requests.create({
      userCode: 'GONE-CODE',
      deviceCodeHash: 'hash-expired',
      status: 'expired',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    await request.save();

    expect(await requests.deleteExpired()).toBe(1);
    expect(await countRows('users_cli_auth_requests')).toBe(0);
  });
});

describe('user retention tasks (#2375)', () => {
  it('are driven by the framework retention sweep', async () => {
    await seedSession({
      userId: 'user-expired',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    const token = await tokens.create({
      nonce: 'nonce-expired',
      email: 'a@example.com',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    await token.save();
    const request = await requests.create({
      userCode: 'ABCD-EFGH',
      deviceCodeHash: 'hash-1',
      status: 'pending',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    await request.save();

    registerUserRetentionTasks();
    const result = await runRetentionSweep(db);

    expect(result.failed).toBe(false);
    for (const name of [
      SESSIONS_RETENTION_TASK,
      MAGIC_LINK_RETENTION_TASK,
      CLI_AUTH_RETENTION_TASK,
    ]) {
      expect(result.tasks.find((task) => task.task === name)?.pruned).toBe(1);
    }

    expect(await countRows('sessions')).toBe(0);
    expect(await countRows('users_magic_link_tokens')).toBe(0);
    expect(await countRows('users_cli_auth_requests')).toBe(0);
  });

  it('deletes nothing under a dry-run sweep', async () => {
    await seedSession({
      userId: 'user-expired',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });

    registerUserRetentionTasks();
    const result = await runRetentionSweep(db, { dryRun: true });

    expect(
      result.tasks.find((task) => task.task === SESSIONS_RETENTION_TASK)
        ?.pruned,
    ).toBe(1);
    expect(await countRows('sessions')).toBe(1);
  });

  it('can be opted out by name and unregistered', async () => {
    await seedSession({
      userId: 'user-expired',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });

    registerUserRetentionTasks();
    const optedOut = await runRetentionSweep(db, {
      tasks: { [SESSIONS_RETENTION_TASK]: false },
    });
    expect(
      optedOut.tasks.find((task) => task.task === SESSIONS_RETENTION_TASK)
        ?.skipped,
    ).toBe('disabled');
    expect(await countRows('sessions')).toBe(1);

    unregisterUserRetentionTasks();
    const removed = await runRetentionSweep(db);
    expect(
      removed.tasks.some((task) => task.task === SESSIONS_RETENTION_TASK),
    ).toBe(false);
  });
});

describe('login limiter and audit retention tasks (#3273)', () => {
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const options = () => ({ db: { type: 'sqlite' as const, url: dbPath } });
  const pruned = (
    result: Awaited<ReturnType<typeof runRetentionSweep>>,
    name: string,
  ) => result.tasks.find((task) => task.task === name)?.pruned;

  /** Fail one attempt for `subject` at the (faked) current time. */
  async function failOnce(limiter: LoginAttemptLimiter, subject: string) {
    const lease = await limiter.reserve({ kind: 'test', subject });
    if (!lease.allowed) throw new Error('expected a lease');
    await lease.fail();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prunes limiter rows only past the horizon of the limiter that wrote them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    await UsersLoginAttemptCollection.create(options());
    // Default horizon: 2 x max(5 min window, 1 h lockout ceiling) = 2 h.
    const standard = await LoginAttemptLimiter.create({
      ...options(),
      audit: false,
    });
    // A deliberately long streak horizon the old fixed sweep ignored.
    const patient = await LoginAttemptLimiter.create({
      ...options(),
      audit: false,
      streakResetSeconds: 24 * 60 * 60,
    });
    await failOnce(standard, 'standard@example.com');
    await failOnce(patient, 'patient@example.com');
    expect(await countRows('users_login_attempts')).toBe(2);

    registerUserRetentionTasks();
    vi.advanceTimersByTime(HOUR_MS);
    expect(
      pruned(await runRetentionSweep(db), LOGIN_ATTEMPTS_RETENTION_TASK),
    ).toBe(0);

    vi.advanceTimersByTime(2 * HOUR_MS); // 3 h: past 2 h, well inside 24 h
    const dryRun = await runRetentionSweep(db, { dryRun: true });
    expect(pruned(dryRun, LOGIN_ATTEMPTS_RETENTION_TASK)).toBe(1);
    expect(await countRows('users_login_attempts')).toBe(2);

    const swept = await runRetentionSweep(db);
    expect(swept.failed).toBe(false);
    expect(pruned(swept, LOGIN_ATTEMPTS_RETENTION_TASK)).toBe(1);
    expect(await countRows('users_login_attempts')).toBe(1);

    vi.advanceTimersByTime(22 * HOUR_MS); // 25 h
    expect(
      pruned(await runRetentionSweep(db), LOGIN_ATTEMPTS_RETENTION_TASK),
    ).toBe(1);
    expect(await countRows('users_login_attempts')).toBe(0);
  });

  it('never prunes a limiter row while its lockout is live', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    // Lockout (3 h) deliberately outlives the retention horizon (1 min).
    const limiter = await LoginAttemptLimiter.create({
      ...options(),
      audit: false,
      maxAttempts: 1,
      windowSeconds: 30,
      streakResetSeconds: 60,
      lockout: { baseSeconds: 3 * 60 * 60, maxSeconds: 3 * 60 * 60 },
    });
    await failOnce(limiter, 'locked@example.com');

    registerUserRetentionTasks();
    vi.advanceTimersByTime(2 * HOUR_MS);
    expect(
      pruned(await runRetentionSweep(db), LOGIN_ATTEMPTS_RETENTION_TASK),
    ).toBe(0);
    vi.advanceTimersByTime(HOUR_MS + MINUTE_MS);
    expect(
      pruned(await runRetentionSweep(db), LOGIN_ATTEMPTS_RETENTION_TASK),
    ).toBe(1);
  });

  it('prunes audit events only after the retention period, and honours dry runs', async () => {
    const events = await UsersLoginAuditEventCollection.create(options());
    for (const [outcome, ageMs] of [
      ['failed', (DEFAULT_LOGIN_AUDIT_RETENTION_DAYS + 1) * DAY_MS],
      ['succeeded', (DEFAULT_LOGIN_AUDIT_RETENTION_DAYS - 1) * DAY_MS],
    ] as const) {
      const event = await events.create({
        kind: 'pin',
        outcome,
        occurredAt: new Date(Date.now() - ageMs),
      });
      await event.save();
    }

    registerUserRetentionTasks();
    const dryRun = await runRetentionSweep(db, { dryRun: true });
    expect(pruned(dryRun, LOGIN_AUDIT_RETENTION_TASK)).toBe(1);
    expect(await countRows('users_login_audit_events')).toBe(2);

    const swept = await runRetentionSweep(db);
    expect(pruned(swept, LOGIN_AUDIT_RETENTION_TASK)).toBe(1);
    const remaining = await events.list({});
    expect(remaining.map((event) => event.outcome)).toEqual(['succeeded']);
  });

  it('can be opted out by name and unregistered', async () => {
    const events = await UsersLoginAuditEventCollection.create(options());
    const event = await events.create({
      kind: 'pin',
      outcome: 'failed',
      occurredAt: new Date(
        Date.now() - (DEFAULT_LOGIN_AUDIT_RETENTION_DAYS + 1) * DAY_MS,
      ),
    });
    await event.save();
    await UsersLoginAttemptCollection.create(options());

    registerUserRetentionTasks();
    const optedOut = await runRetentionSweep(db, {
      tasks: {
        [LOGIN_AUDIT_RETENTION_TASK]: false,
        [LOGIN_ATTEMPTS_RETENTION_TASK]: false,
      },
    });
    for (const name of [
      LOGIN_AUDIT_RETENTION_TASK,
      LOGIN_ATTEMPTS_RETENTION_TASK,
    ]) {
      expect(optedOut.tasks.find((task) => task.task === name)?.skipped).toBe(
        'disabled',
      );
    }
    expect(await countRows('users_login_audit_events')).toBe(1);

    unregisterUserRetentionTasks();
    const removed = await runRetentionSweep(db);
    expect(
      removed.tasks.some(
        (task) =>
          task.task === LOGIN_AUDIT_RETENTION_TASK ||
          task.task === LOGIN_ATTEMPTS_RETENTION_TASK,
      ),
    ).toBe(false);
  });
});

describe('expiry predicate indexes (#2375)', () => {
  it('indexes expires_at on every credential table', async () => {
    const result = await db.query(
      `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'`,
    );
    const indexedTables = new Set(
      result.rows
        .filter((row) => String(row.name).includes('expires_at'))
        .map((row) => String(row.tbl_name)),
    );

    expect(indexedTables).toContain('sessions');
    expect(indexedTables).toContain('users_magic_link_tokens');
    expect(indexedTables).toContain('users_cli_auth_requests');
  });
});
