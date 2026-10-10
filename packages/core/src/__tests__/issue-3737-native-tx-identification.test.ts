/**
 * #3737 round 2: native DuckDB identification must not depend on process
 * history. A transaction handle carries the root's `client` but none of the
 * adapter's structural markers, so it can only be recognized through a root
 * that core noted before binding to it. This file runs in its own module
 * state (Vitest isolates files) and never writes through a root handle before
 * the transaction: the parent and its referencing child are inserted raw.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators/index.js';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const TABLE = 'issue3737_tx_parents';

@smrt({ tableName: 'issue3737_tx_parents' })
class Issue3737TxParent extends SmrtObject {
  @field({ type: 'boolean' })
  enabled = true;
}

class Issue3737TxParents extends SmrtCollection<Issue3737TxParent> {
  static readonly _itemClass = Issue3737TxParent;
}

async function seedReferencedParent(db: DatabaseInterface): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(TABLE, {
    id,
    slug: 'parent-1',
    context: '',
    created_at: now,
    updated_at: now,
    enabled: true,
  });
  await db.query(
    `CREATE TABLE issue3737_tx_children (id UUID PRIMARY KEY, parent_id UUID REFERENCES ${TABLE}(id))`,
  );
  await db.insert('issue3737_tx_children', {
    id: randomUUID(),
    parent_id: id,
  });
  return id;
}

describe('native DuckDB identification inside transactions (#3737)', () => {
  let db: DatabaseInterface;
  let id: string;

  beforeEach(async () => {
    ObjectRegistry.registerCollection('Issue3737TxParent', Issue3737TxParents);
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Issue3737TxParent'],
    });
    id = await seedReferencedParent(db);
  });

  afterEach(async () => {
    await db?.close?.();
  });

  const enabledOf = async () =>
    (await db.query(`SELECT enabled FROM ${TABLE} WHERE id = ?`, id)).rows[0]
      .enabled;

  it('toggles a referenced parent inside withTransaction()', async () => {
    const parent = new Issue3737TxParent({ db, id });
    await parent.initialize();
    await parent.withTransaction(async (bound) => {
      bound.enabled = false;
      await bound.save();
    });
    expect(await enabledOf()).toBe(false);
  });

  it('toggles a referenced parent through a transaction-bound collection', async () => {
    // Apps create their collections on the root; no write happens here.
    await Issue3737TxParents.create({ db });
    await db.transaction?.(async (tx) => {
      const parents = await Issue3737TxParents.create({ db: tx });
      const parent = await parents.get(id);
      if (!parent) throw new Error('expected the parent');
      parent.enabled = false;
      await parent.save();
    });
    expect(await enabledOf()).toBe(false);
  });

  it('toggles a referenced parent through a core-opened transaction', async () => {
    await withEmbeddedWriteTransaction(db, true, async (tx) => {
      const parents = await Issue3737TxParents.create({ db: tx });
      const parent = await parents.get(id);
      if (!parent) throw new Error('expected the parent');
      parent.enabled = false;
      await parent.save();
    });
    expect(await enabledOf()).toBe(false);
  });
});

describe('the JSON adapter is never identified as native in a transaction (#3737)', () => {
  let dir: string;
  let db: DatabaseInterface;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'issue3737-json-tx-'));
    db = await getTestDatabase({
      type: 'json',
      url: dir,
      classes: ['Issue3737TxParent'],
    });
  });

  afterEach(async () => {
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a save made inside withTransaction() to the table file', async () => {
    const created = new Issue3737TxParent({ db, slug: 'parent-1' });
    await created.initialize();
    await created.save();
    await created.withTransaction(async (bound) => {
      bound.enabled = false;
      await bound.save();
    });
    const rows = JSON.parse(readFileSync(join(dir, `${TABLE}.json`), 'utf8'));
    expect(
      rows.find((row: { id: string }) => row.id === created.id)?.enabled,
    ).toBe(false);
  });
});
