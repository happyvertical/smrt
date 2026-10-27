/**
 * #3657: createDispatchBus retries a transient connection failure during its
 * startup bootstrap, and fails at once on anything else.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransientConnectionError } from '../db-errors.js';
import { getDatabase } from '../host.js';
import { createDispatchBus, DispatchBus } from './bus.js';

const paths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

/**
 * A real SQLite database whose bus bootstrap fails with `failures` first.
 * The failure is injected at `initialize()`, which is where a dropped
 * PostgreSQL connection surfaces at startup.
 */
async function flakyDatabase(failures: Error[]): Promise<{
  db: DatabaseInterface;
  calls: () => number;
}> {
  const path = join(tmpdir(), `smrt-bus-retry-${randomUUID().slice(0, 8)}.db`);
  paths.push(path);
  const db = (await getDatabase({
    type: 'sqlite',
    url: path,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  const realInitialize = DispatchBus.prototype.initialize;
  let calls = 0;
  vi.spyOn(DispatchBus.prototype, 'initialize').mockImplementation(function (
    this: DispatchBus,
  ) {
    calls += 1;
    const failure = failures.shift();
    if (failure) return Promise.reject(failure);
    return realInitialize.call(this);
  });
  return { db, calls: () => calls };
}

function pgError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}

const fast = { attempts: 4, initialDelayMs: 1, maxDelayMs: 2 };

describe('createDispatchBus startup retry (#3657)', () => {
  it('retries a dropped first connection and then initializes', async () => {
    const { db, calls } = await flakyDatabase([
      pgError('Connection terminated unexpectedly'),
      pgError('the database system is starting up', '57P03'),
    ]);
    const bus = await createDispatchBus({ db, startupRetry: fast });
    expect(calls()).toBe(3);
    await expect(bus.emit('probe.started', {})).resolves.toBeDefined();
  });

  it('fails at once on a non-connection error', async () => {
    const { db, calls } = await flakyDatabase([
      pgError('password authentication failed for user "app"', '28P01'),
    ]);
    await expect(createDispatchBus({ db, startupRetry: fast })).rejects.toThrow(
      /password authentication failed/,
    );
    expect(calls()).toBe(1);
  });

  it('gives up after the configured number of attempts', async () => {
    const { db, calls } = await flakyDatabase(
      Array.from({ length: 10 }, () =>
        pgError('connect ECONNREFUSED', 'ECONNREFUSED'),
      ),
    );
    await expect(createDispatchBus({ db, startupRetry: fast })).rejects.toThrow(
      /ECONNREFUSED/,
    );
    expect(calls()).toBe(4);
  });

  it('can be switched off', async () => {
    const { db, calls } = await flakyDatabase([
      pgError('Connection terminated unexpectedly'),
    ]);
    await expect(
      createDispatchBus({ db, startupRetry: false }),
    ).rejects.toThrow(/Connection terminated/);
    expect(calls()).toBe(1);
  });
});

describe('isTransientConnectionError (#3657)', () => {
  it.each([
    ['Connection terminated unexpectedly', undefined],
    ['Connection terminated due to connection timeout', undefined],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'],
    ['read ECONNRESET', 'ECONNRESET'],
    ['connect ETIMEDOUT', 'ETIMEDOUT'],
    ['getaddrinfo EAI_AGAIN db', 'EAI_AGAIN'],
    ['connection failure', '08006'],
    ['terminating connection due to administrator command', '57P01'],
    ['crash shutdown', '57P02'],
    ['the database system is starting up', '57P03'],
    ['sorry, too many clients already', '53300'],
  ])('treats %s as a transient connection failure', (message, code) => {
    expect(isTransientConnectionError(pgError(message, code))).toBe(true);
  });

  it.each([
    ['password authentication failed for user "app"', '28P01'],
    ['database "app" does not exist', '3D000'],
    ['relation "x" does not exist', '42P01'],
    ['deadlock detected', '40P01'],
    ['getaddrinfo ENOTFOUND db.example', 'ENOTFOUND'],
    ['connect EHOSTUNREACH 10.0.0.9:5432', 'EHOSTUNREACH'],
    ['connect ENETUNREACH 10.0.0.9:5432', 'ENETUNREACH'],
    ['plain failure', undefined],
  ])('does not retry %s', (message, code) => {
    expect(isTransientConnectionError(pgError(message, code))).toBe(false);
  });
});
