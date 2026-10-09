import { randomUUID } from 'node:crypto';
import {
  type DatabaseInterface,
  getDatabase,
  type SessionHandle,
} from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropExecutionDatabase } from './test-support/postgres-cleanup.js';

function sqlState(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9]{5}$/.test(error.code)
  )
    return error.code;
  return 'cause' in error ? sqlState(error.cause) : undefined;
}

describe('PostgreSQL fixture cleanup with real sessions', () => {
  let admin: DatabaseInterface;
  let peer: DatabaseInterface | undefined;
  let session: SessionHandle | undefined;
  let name: string;
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('PostgreSQL required');
    admin = await getDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    });
    name = '';
  });
  afterEach(async () => {
    await session?.release();
    session = undefined;
    await peer?.close?.();
    peer = undefined;
    if (name) await dropExecutionDatabase(admin, name);
    await admin?.close?.();
  });
  async function create(prefix: string) {
    name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    peer = await getDatabase({ type: 'postgres', url: url.toString() });
    if (!peer.acquireSession)
      throw new Error('Pinned PostgreSQL sessions required');
    session = await peer.acquireSession();
    await session.query('SELECT 1');
  }
  it.each([
    'exec',
    'ing',
    'ext',
    'sources',
  ])('retries %s only until its session closes naturally', async (prefix) => {
    await create(prefix);
    let markBusy!: () => void;
    const busy = new Promise<void>((resolve) => {
      markBusy = resolve;
    });
    let attempts = 0;
    const query: DatabaseInterface['query'] = async (...args) => {
      attempts++;
      try {
        return await admin.query(...args);
      } catch (error) {
        if (sqlState(error) === '55006') markBusy();
        throw error;
      }
    };
    const cleanup = dropExecutionDatabase({ query }, name);
    // Attach the rejection handler before waiting on the observed busy response.
    const outcome = cleanup.then(
      () => undefined,
      (error) => error,
    );
    await Promise.race([
      busy,
      outcome.then((error) => {
        throw error ?? new Error('Expected busy response');
      }),
    ]);
    expect((await session!.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
    await session!.release();
    session = undefined;
    await peer!.close?.();
    peer = undefined;
    expect(await outcome).toBeUndefined();
    expect(attempts).toBeGreaterThan(1);
    expect(
      (
        await admin.query(
          'SELECT datname FROM pg_database WHERE datname=?',
          name,
        )
      ).rows,
    ).toEqual([]);
  });
  it('fails a leaked session at the deadline without terminating it', async () => {
    await create('ext');
    let error: unknown;
    try {
      await dropExecutionDatabase(admin, name, 0);
    } catch (caught) {
      error = caught;
    }
    expect(sqlState(error)).toBe('55006');
    expect((await session!.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
    expect(
      (
        await admin.query(
          'SELECT datname FROM pg_database WHERE datname=?',
          name,
        )
      ).rows,
    ).toHaveLength(1);
    await session!.release();
    session = undefined;
    await peer!.close?.();
    peer = undefined;
    await dropExecutionDatabase(admin, name);
    await dropExecutionDatabase(admin, name);
  });
});
