import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmrtClass } from '../class';
import { SMRT_SCHEMA_VERSION } from '../system/schema';
import { getTestDatabase } from '../testing/database';

class BootstrapProbe extends SmrtClass {
  async ready() {
    await this.initializeCoreResources();
  }
}

const databases: DatabaseInterface[] = [];
const paths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close?.();
  for (const path of paths.splice(0)) await rm(path, { force: true });
});

function observeBootstrap(db: DatabaseInterface) {
  const query = vi.spyOn(db, 'query');
  return () =>
    query.mock.calls.filter(
      ([sql, ...parameters]) =>
        sql.includes('SELECT 1 FROM _smrt_migrations WHERE version') &&
        parameters.includes(SMRT_SCHEMA_VERSION),
    ).length;
}

describe.each([
  'sqlite',
  'duckdb',
] as const)('concurrent system initialization: %s (#3944)', (type) => {
  it('coalesces first constructors on a provisioned handle and retains the success cache', async () => {
    const db = await getTestDatabase({ type, classes: [] });
    databases.push(db);
    const attempts = observeBootstrap(db);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => new BootstrapProbe({ db }).ready()),
    );
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(attempts()).toBe(1);
    await new BootstrapProbe({ db }).ready();
    expect(attempts()).toBe(1);
    const rows = await db.query('SELECT * FROM _smrt_migrations');
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('keeps independent memory handles separate despite their identical URL', async () => {
    const first = await getTestDatabase({ type, classes: [] });
    const second = await getTestDatabase({ type, classes: [] });
    databases.push(first, second);
    const attemptsA = observeBootstrap(first);
    const attemptsB = observeBootstrap(second);
    await Promise.all([
      new BootstrapProbe({ db: first }).ready(),
      new BootstrapProbe({ db: second }).ready(),
    ]);
    expect(attemptsA()).toBe(1);
    expect(attemptsB()).toBe(1);
  });

  it('shares the initialization failure and allows a fresh attempt to retry', async () => {
    const db = await getDatabase({ type, url: ':memory:' });
    databases.push(db);
    // Fail the final version stamp, after real DDL has run. Every waiter
    // must reject, no success cache may be set, and a retry must finish.
    const failure = new Error('injected version-stamp failure');
    const execute = vi.spyOn(db, 'execute').mockRejectedValueOnce(failure);
    const results = await Promise.allSettled([
      new BootstrapProbe({ db }).ready(),
      new BootstrapProbe({ db }).ready(),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason.cause).toBe(failure);
      }
    }
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockRestore();
    await new BootstrapProbe({ db }).ready();
    const attempts = observeBootstrap(db);
    await new BootstrapProbe({ db }).ready();
    expect(attempts()).toBe(0);
    const rows = await db.query(
      'SELECT version FROM _smrt_migrations WHERE version = ?',
      SMRT_SCHEMA_VERSION,
    );
    expect(rows.rows).toHaveLength(1);
  });
});

it('does not share in-flight work across distinct handles with the same URL', async () => {
  const path = join(tmpdir(), `smrt-3944-${randomUUID()}.db`);
  paths.push(path);
  const db = await getDatabase({ type: 'sqlite', url: path });
  databases.push(db);
  // A second adapter facade of the same native connection has a different
  // object identity but the same persistent URL. In-flight work must retain
  // handle identity because real handles can own different transactions.
  const second = { ...db };
  const attemptsA = observeBootstrap(db);
  const attemptsB = observeBootstrap(second);
  await Promise.all([
    new BootstrapProbe({ db }).ready(),
    new BootstrapProbe({ db: second }).ready(),
  ]);
  expect(attemptsA()).toBe(1);
  expect(attemptsB()).toBe(1);
});
