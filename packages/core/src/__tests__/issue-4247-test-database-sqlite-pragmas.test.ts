/**
 * Issue #4247: `getTestDatabase()` opens its connection with
 * `__smrtSkipVitestSchemaPreparation`, which also bypassed smrt-vitest's
 * #2221 speed pragmas. Every commit on a file-backed test database then
 * fsynced, which made ingestion fixtures take 15 s on a loaded host.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { getTestDatabase } from '../testing/database';

async function pragma(db: DatabaseInterface, name: string): Promise<unknown> {
  const { rows } = await db.query(`PRAGMA ${name}`);
  return Object.values(rows[0] ?? {})[0];
}

describe('Issue #4247: getTestDatabase SQLite speed pragmas', () => {
  let root: string | undefined;
  let db: DatabaseInterface | undefined;
  afterEach(async () => {
    await db?.close?.();
    db = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('strips fsync and journal-file I/O from a file-backed database', async () => {
    root = await mkdtemp(join(tmpdir(), 'issue-4247-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: `file:${join(root, 'test.sqlite')}`,
      classes: [],
    });
    expect(Number(await pragma(db, 'synchronous'))).toBe(0);
    expect(String(await pragma(db, 'journal_mode')).toLowerCase()).toBe(
      'memory',
    );
  });

  it('leaves in-memory SQLite on its defaults', async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    expect(String(await pragma(db, 'journal_mode')).toLowerCase()).toBe(
      'memory',
    );
    expect(Number(await pragma(db, 'synchronous'))).not.toBe(0);
  });

  it('leaves a caller-supplied database untouched', async () => {
    root = await mkdtemp(join(tmpdir(), 'issue-4247-'));
    const { getDatabase } = await import('@happyvertical/sql');
    db = await getDatabase({
      type: 'sqlite',
      url: `file:${join(root, 'own.sqlite')}`,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    const before = Number(await pragma(db, 'synchronous'));
    await getTestDatabase({ db, classes: [] });
    expect(Number(await pragma(db, 'synchronous'))).toBe(before);
  });
});
