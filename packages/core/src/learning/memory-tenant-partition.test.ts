/**
 * Keyed learning memory is partitioned by tenant (#5449).
 *
 * `LearningMemory` files a memory under `(owner_class, owner_id, scope, key,
 * version)` plus the tenant it was constructed for. Two tenants that use the
 * same owner string (for example the same persona `memoryScope`) keep separate
 * memories; a memory built without a tenant uses the global partition, which a
 * tenant-bound memory never reads or writes.
 *
 * Runs on real in-memory SQLite; PGlite joins when the lane sets
 * `SMRT_TEST_PGLITE=1` (`pnpm test:pglite`). Never mocks the database.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestDatabase } from '../testing/database';
import { LearningMemory } from './memory';

type Engine = 'sqlite' | 'duckdb' | 'pglite';

const engines: Engine[] = [
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
];

const OWNER_CLASS = 'PartitionedLearner';
const SHARED_OWNER = 'invoice-processing';
const TENANT_A = '0b9f6a3e-6d0c-4d55-9f43-2f1d4a0c0a01';
const TENANT_B = '7c1e2b44-91aa-4f0e-8d55-5a6b7c8d9e02';
const EPISODE = { scope: 'parser/acme', key: 'invoice' };

const open: DatabaseInterface[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of open.splice(0)) await db.close?.();
});

async function newDatabase(engine: Engine): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: engine,
    classes: [],
    includeSystemTables: true,
  });
  open.push(db);
  return db;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function memoryFor(db: DatabaseInterface, tenantId?: string | null) {
  return new LearningMemory({
    db,
    ownerClass: OWNER_CLASS,
    ownerId: SHARED_OWNER,
    ...(tenantId !== undefined ? { tenantId } : {}),
  });
}

async function storedRows(db: DatabaseInterface) {
  return rowsOf(
    await db.query(
      `SELECT * FROM _smrt_contexts WHERE owner_class = ? ORDER BY value`,
      OWNER_CLASS,
    ),
  );
}

describe.each(engines)('LearningMemory tenant partition (%s)', (engine) => {
  it('does not recall a memory captured by another tenant under the same owner', async () => {
    const db = await newDatabase(engine);
    const tenantA = memoryFor(db, TENANT_A);
    const tenantB = memoryFor(db, TENANT_B);

    await tenantA.capture(
      { ...EPISODE, value: { strategy: 'a' } },
      { success: true },
    );

    expect(await tenantB.recall(EPISODE.scope, { key: EPISODE.key })).toEqual(
      [],
    );
    expect(await tenantB.recall(EPISODE.scope)).toEqual([]);
    const [own] = await tenantA.recall(EPISODE.scope, { key: EPISODE.key });
    expect(own?.value).toEqual({ strategy: 'a' });
  });

  it('keeps a separate row per tenant when both capture the same scope and key', async () => {
    const db = await newDatabase(engine);
    const tenantA = memoryFor(db, TENANT_A);
    const tenantB = memoryFor(db, TENANT_B);

    await tenantA.capture(
      { ...EPISODE, value: { strategy: 'a' } },
      { success: true },
    );
    // B's first capture seeds its own memory and must not reinforce A's.
    const seeded = await tenantB.capture(
      { ...EPISODE, value: { strategy: 'b' } },
      { success: false },
    );
    expect(seeded?.successCount).toBe(0);
    expect(seeded?.failureCount).toBe(1);

    const rows = await storedRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tenant_id).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );

    const [a] = await tenantA.recall(EPISODE.scope, { key: EPISODE.key });
    expect(a?.value).toEqual({ strategy: 'a' });
    expect(a?.successCount).toBe(1);
    expect(a?.failureCount).toBe(0);
    // B's memory decayed below the reuse floor; A's still counts as confident.
    expect(await tenantB.recall(EPISODE.scope, { key: EPISODE.key })).toEqual(
      [],
    );
  });

  it('keeps the global partition separate from every tenant partition', async () => {
    const db = await newDatabase(engine);
    const global = memoryFor(db);
    const nullTenant = memoryFor(db, null);
    const tenantA = memoryFor(db, TENANT_A);

    await global.capture(
      { ...EPISODE, value: { strategy: 'global' } },
      { success: true },
    );

    // A tenant-bound memory does not fall back to the global partition.
    expect(await tenantA.recall(EPISODE.scope, { key: EPISODE.key })).toEqual(
      [],
    );
    // An explicit null tenant is the global partition.
    const [shared] = await nullTenant.recall(EPISODE.scope, {
      key: EPISODE.key,
    });
    expect(shared?.value).toEqual({ strategy: 'global' });

    await tenantA.capture(
      { ...EPISODE, value: { strategy: 'a' } },
      { success: true },
    );
    const [globalHit] = await global.recall(EPISODE.scope, {
      key: EPISODE.key,
    });
    expect(globalHit?.value).toEqual({ strategy: 'global' });
    expect(globalHit?.successCount).toBe(1);
  });

  it('reads a row stored before tenant partitioning only from the global partition', async () => {
    const db = await newDatabase(engine);
    const global = memoryFor(db);
    const tenantA = memoryFor(db, TENANT_A);
    await db.insert('_smrt_contexts', {
      id: crypto.randomUUID(),
      owner_class: OWNER_CLASS,
      owner_id: SHARED_OWNER,
      scope: EPISODE.scope,
      key: EPISODE.key,
      value: JSON.stringify({ strategy: 'legacy' }),
      version: 1,
      confidence: 0.95,
    });

    expect(await tenantA.recall(EPISODE.scope, { key: EPISODE.key })).toEqual(
      [],
    );
    const [legacy] = await global.recall(EPISODE.scope, { key: EPISODE.key });
    expect(legacy?.value).toEqual({ strategy: 'legacy' });
  });

  it('does not reinforce a row that moved to a tenant between its lookup and its update', async () => {
    const db = await newDatabase(engine);
    const global = memoryFor(db);
    await global.capture(
      { ...EPISODE, value: { strategy: 'before-move' } },
      { success: true },
    );
    const [moved] = await storedRows(db);
    const query = db.query.bind(db);
    const write = db.update.bind(db);
    let moves = 0;
    // An operator moves the row into a tenant after capture() read it and
    // before capture() writes it, whichever statement the write uses.
    const moveOnce = async () => {
      if (moves++ > 0) return;
      await query(
        'UPDATE _smrt_contexts SET tenant_id = ? WHERE id = ?',
        TENANT_A,
        moved?.id,
      );
    };
    vi.spyOn(db, 'update').mockImplementation(async (...args) => {
      await moveOnce();
      return write(...args);
    });
    vi.spyOn(db, 'query').mockImplementation(async (sql, ...args) => {
      if (/^\s*UPDATE _smrt_contexts\s+SET (?!tenant_id)/.test(String(sql))) {
        await moveOnce();
      }
      return query(sql, ...args);
    });

    const record = await global.capture(
      { ...EPISODE, value: { strategy: 'after-move' } },
      { success: true },
    );

    const rows = await storedRows(db);
    const tenantRow = rows.find((row) => row.tenant_id === TENANT_A);
    expect(tenantRow?.id).toBe(moved?.id);
    expect(tenantRow?.value).toBe(JSON.stringify({ strategy: 'before-move' }));
    expect(Number(tenantRow?.success_count)).toBe(1);
    // The global caller seeds a fresh global memory instead.
    const globalRow = rows.find((row) => row.tenant_id === '');
    expect(globalRow?.value).toBe(JSON.stringify({ strategy: 'after-move' }));
    expect(record?.id).toBe(globalRow?.id);
    expect(record?.successCount).toBe(1);
  });

  it('does not touch a recalled row that moved to a tenant before the touch', async () => {
    const db = await newDatabase(engine);
    const global = memoryFor(db);
    await global.capture(
      { ...EPISODE, value: { strategy: 'kept' } },
      { success: true },
    );
    const [row] = await storedRows(db);
    const query = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql, ...args) => {
      if (/SET last_used_at/.test(String(sql))) {
        await query(
          'UPDATE _smrt_contexts SET tenant_id = ? WHERE id = ?',
          TENANT_A,
          row?.id,
        );
      }
      return query(sql, ...args);
    });

    await global.recall(EPISODE.scope, {
      key: EPISODE.key,
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    vi.restoreAllMocks();

    const [after] = await storedRows(db);
    expect(after?.tenant_id).toBe(TENANT_A);
    expect(String(after?.last_used_at)).not.toContain('2099');
  });
});
