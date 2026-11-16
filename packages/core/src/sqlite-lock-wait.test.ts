import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase as getSqlDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from './host.js';
import {
  applyCollectionLockWait,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_COLLECTION_BUSY_TIMEOUT_MS,
} from './sqlite-lock-wait.js';

let dir: string;
const open: Array<{ close?: () => Promise<void> }> = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-lock-wait-')));
});

afterEach(async () => {
  for (const db of open.splice(0)) await db.close?.().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function busyTimeout(db: {
  query(sql: string): Promise<{ rows: unknown[] }>;
}): Promise<number> {
  const result = await db.query('PRAGMA busy_timeout');
  return Number(Object.values(result.rows[0] as object)[0]);
}

describe('collection lock wait (#4978)', () => {
  it('waits for the lock on a file-backed node:sqlite connection opened through the host', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: join(dir, 'a.sqlite'),
      cache: false,
      secureFile: {
        driver: 'node:sqlite',
        custody: 'trusted-parent',
        root: dir,
      },
    });
    open.push(db);
    expect(db.engine).toBe('node-sqlite');
    expect(await busyTimeout(db)).toBe(SQLITE_COLLECTION_BUSY_TIMEOUT_MS);
  });

  it('waits for the lock on a file-backed libsql connection', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: join(dir, 'b.sqlite'),
      cache: false,
    });
    open.push(db);
    expect(db.engine).toBe('libsql');
    expect(await busyTimeout(db)).toBe(SQLITE_COLLECTION_BUSY_TIMEOUT_MS);
  });

  it('keeps a longer timeout the runtime already set', async () => {
    const db = await getSqlDatabase({
      type: 'sqlite',
      url: join(dir, 'c.sqlite'),
      cache: false,
    });
    open.push(db);
    await db.query(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    await applyCollectionLockWait(db);
    expect(await busyTimeout(db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('leaves in-memory SQLite untouched', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      cache: false,
    });
    open.push(db);
    expect(await busyTimeout(db)).toBe(0);
  });

  it('applies once per connection', async () => {
    const db = await getSqlDatabase({
      type: 'sqlite',
      url: join(dir, 'd.sqlite'),
      cache: false,
    });
    open.push(db);
    await applyCollectionLockWait(db);
    await db.query('PRAGMA busy_timeout = 0');
    await applyCollectionLockWait(db);
    expect(await busyTimeout(db)).toBe(0);
  });
});
