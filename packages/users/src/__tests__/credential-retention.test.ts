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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsersCliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { UsersMagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import {
  CLI_AUTH_RETENTION_TASK,
  MAGIC_LINK_RETENTION_TASK,
  registerUserRetentionTasks,
  SESSIONS_RETENTION_TASK,
  unregisterUserRetentionTasks,
} from '../retention.js';
import { SessionStatus } from '../types/index.js';

const MINUTE_MS = 60 * 1000;

let dbPath: string;
let sessions: SessionCollection;
let tokens: UsersMagicLinkTokenCollection;
let requests: UsersCliAuthRequestCollection;
let db: DatabaseInterface;

beforeEach(async () => {
  clearRetentionTasks();
  dbPath = join(tmpdir(), `smrt-credential-retention-${Date.now()}.db`);
  const options = { db: { type: 'sqlite' as const, url: dbPath } };

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
