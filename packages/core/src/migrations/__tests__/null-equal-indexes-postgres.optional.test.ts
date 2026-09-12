import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import { SchemaGenerator } from '../../schema/generator.js';
import type { SchemaDefinition } from '../../schema/types.js';
import {
  collectNullEqualIndexTargets,
  migrateNullEqualIndexes,
  preflightNullEqualIndexes,
} from '../null-equal-indexes.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const suite = pgUrl ? describe.sequential : describe.skip;
const prefix = `i2834_${randomUUID().slice(0, 8)}`;

suite('NULL-equal framework identities on real PostgreSQL (#2834)', () => {
  let db: DatabaseInterface;
  let version: number;
  const tables = new Set<string>();
  beforeAll(async () => {
    db = await getDatabase({ type: 'postgres', url: pgUrl });
    version = Number(
      (await db.query('SHOW server_version_num')).rows[0].server_version_num,
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const table of tables)
      await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    tables.clear();
  });
  afterAll(async () => {
    await db.close?.();
  });

  function schema(label: string): SchemaDefinition {
    const tableName = `${prefix}_${label}`;
    tables.add(tableName);
    // Exercise the production generator, not a hand-marked NND test fixture.
    return new SchemaGenerator().generateSchemaFromRegistry(
      'NullIdentity2834',
      tableName,
      new Map([
        ['id', { type: 'text' }],
        ['slug', { type: 'text', _meta: { required: true } }],
        ['context', { type: 'text', _meta: { required: true } }],
        [
          'tenantId',
          {
            type: 'foreignKey',
            related: 'Tenant',
            _meta: {
              nullable: true,
              __tenancy: { mode: 'optional', isTenantIdField: true },
            },
          },
        ],
        [
          'optionalCode',
          { type: 'text', _meta: { nullable: true, unique: true } },
        ],
      ]) as never,
      { tenantScoped: true },
    );
  }
  async function create(definition: SchemaDefinition, legacy = false) {
    const ddl = getDDLStrategy('postgres');
    await db.query(ddl.generateCreateTable(definition));
    for (const sql of ddl.generateIndexes(
      legacy
        ? {
            ...definition,
            indexes: definition.indexes?.map((index) => ({
              ...index,
              nullsNotDistinct: undefined,
            })),
          }
        : definition,
    ))
      await db.query(sql);
  }
  const data = (tenant: string | null, name = 'shared') => ({
    id: randomUUID(),
    slug: name,
    context: '',
    tenant_id: tenant,
  });
  const key = ['tenant_id', 'slug', 'context'];
  async function warmCount(connection: DatabaseInterface, table: string) {
    await connection.upsert(table, key, data(null));
    const spy = vi.spyOn(connection.client, 'query');
    try {
      await connection.upsert(table, key, data(null));
      if (version >= 150000) {
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0]?.[0])).toMatch(
          /^INSERT INTO .*ON CONFLICT/s,
        );
      } else {
        // The legacy fallback uses a checked-out transaction client, not
        // the direct pool query used by native upsert. Row/concurrency checks
        // below verify correctness without claiming a pool-level total count.
        expect(
          spy.mock.calls.some(([sql]) =>
            /^INSERT INTO .*ON CONFLICT/s.test(String(sql)),
          ),
        ).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
  }

  it('generates version-compatible indexes and warms one-statement NULL upserts only on PG15+', async () => {
    const definition = schema('fresh');
    await create(definition);
    await warmCount(db, definition.tableName);
    const targets = collectNullEqualIndexTargets({ model: definition });
    expect(targets).toHaveLength(1);
    const state = await preflightNullEqualIndexes(db, targets);
    expect(state.supported).toBe(version >= 150000);
    if (state.supported) expect(state.indexes[0].state).toBe('current');
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        db.upsert(
          definition.tableName,
          key,
          data(i % 3 === 0 ? null : i % 3 === 1 ? tenantA : tenantB),
        ),
      ),
    );
    const rows = await db.query(
      `SELECT tenant_id, COUNT(*) AS count FROM "${definition.tableName}" GROUP BY tenant_id`,
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((row) => Number(row.count) === 1)).toBe(true);
  });

  it('upgrades legacy indexes atomically, is retry-safe, and refreshes the negative adapter probe', async () => {
    const definition = schema('legacy');
    await create(definition, true);
    await db.upsert(definition.tableName, key, data(null)); // cache legacy false
    const targets = collectNullEqualIndexTargets({ model: definition });
    const result = await migrateNullEqualIndexes(db, targets);
    if (version < 150000) {
      expect(result.statements).toEqual([]);
      return;
    }
    expect(result.statements).toHaveLength(2);
    expect((await migrateNullEqualIndexes(db, targets)).statements).toEqual([]);
    // Public connection replacement, never a private capability-cache mutation.
    const fresh = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      clearCache: true,
    });
    db = fresh;
    await warmCount(fresh, definition.tableName);
    expect(
      Number(
        (
          await fresh.query(
            `SELECT COUNT(*) AS count FROM "${definition.tableName}"`,
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  });

  it('reports duplicates without changing rows or the original index', async () => {
    if (version < 150000) return;
    const definition = schema('duplicates');
    await create(definition, true);
    await db.insert(definition.tableName, [data(null), data(null)]);
    const targets = collectNullEqualIndexTargets({ model: definition });
    const before = await preflightNullEqualIndexes(db, targets);
    expect(before.indexes[0]).toMatchObject({
      state: 'blocked',
      duplicateGroups: 1,
    });
    await expect(migrateNullEqualIndexes(db, targets)).rejects.toThrow(
      'duplicate NULL-equal',
    );
    expect(
      Number(
        (
          await db.query(
            `SELECT COUNT(*) AS count FROM "${definition.tableName}"`,
          )
        ).rows[0].count,
      ),
    ).toBe(2);
    expect(
      (await preflightNullEqualIndexes(db, targets)).indexes[0].duplicateGroups,
    ).toBe(1);
  });

  it('rolls back every replacement after a DDL failure and succeeds on retry', async () => {
    if (version < 150000) return;
    const definition = schema('rollback_a');
    const second = schema('rollback_b');
    await create(definition, true);
    await create(second, true);
    const targets = collectNullEqualIndexTargets({ model: definition, second });
    const transaction = db.transaction.bind(db);
    const wrapped = {
      ...db,
      transaction: (callback: (tx: DatabaseInterface) => Promise<unknown>) =>
        transaction(async (tx) => {
          const query = tx.query.bind(tx);
          return callback({
            ...tx,
            query: async (sql: string, ...values: unknown[]) => {
              if (
                sql.startsWith('CREATE UNIQUE INDEX') &&
                sql.includes(second.tableName)
              )
                await query('SELECT 1 / 0');
              return query(sql, ...values);
            },
          } as DatabaseInterface);
        }),
    } as DatabaseInterface;
    await expect(migrateNullEqualIndexes(wrapped, targets)).rejects.toThrow();
    expect(
      (await preflightNullEqualIndexes(db, targets)).indexes.map(
        (index) => index.state,
      ),
    ).toEqual(['pending', 'pending']);
    expect(
      (await migrateNullEqualIndexes(db, targets)).statements,
    ).toHaveLength(4);
  });

  it('refuses foreign-key dependent and constraint-owned indexes without dropping dependencies', async () => {
    if (version < 150000) return;
    const definition = schema('dependent');
    await create(definition, true);
    const child = `${prefix}_child`;
    tables.add(child);
    await db.query(
      `CREATE TABLE "${child}" (tenant_id UUID, slug TEXT, context TEXT, FOREIGN KEY (tenant_id, slug, context) REFERENCES "${definition.tableName}" (tenant_id, slug, context))`,
    );
    const targets = collectNullEqualIndexTargets({ model: definition });
    await expect(migrateNullEqualIndexes(db, targets)).rejects.toThrow(
      'dependencies',
    );
    await db.query(`DROP TABLE "${child}"`);
    tables.delete(child);
    await db.query(
      `ALTER TABLE "${definition.tableName}" ADD CONSTRAINT "${targets[0].index}" UNIQUE USING INDEX "${targets[0].index}"`,
    );
    await expect(migrateNullEqualIndexes(db, targets)).rejects.toThrow(
      'constraint ownership',
    );
  });
  it('rechecks rows and dependencies changed after preflight before replacing indexes', async () => {
    if (version < 150000) return;
    const definition = schema('race');
    await create(definition, true);
    const targets = collectNullEqualIndexTargets({ model: definition });
    const transaction = db.transaction.bind(db);
    const concurrentInsert = {
      ...db,
      transaction: async (callback: Parameters<typeof transaction>[0]) => {
        await db.insert(definition.tableName, [data(null), data(null)]);
        return transaction(callback);
      },
    } as DatabaseInterface;
    await expect(
      migrateNullEqualIndexes(concurrentInsert, targets),
    ).rejects.toThrow('duplicate NULL-equal');
    await db.query(`DELETE FROM "${definition.tableName}"`);
    const concurrentConstraint = {
      ...db,
      transaction: async (callback: Parameters<typeof transaction>[0]) => {
        await db.query(
          `ALTER TABLE "${definition.tableName}" ADD CONSTRAINT "${targets[0].index}" UNIQUE USING INDEX "${targets[0].index}"`,
        );
        return transaction(callback);
      },
    } as DatabaseInterface;
    await expect(
      migrateNullEqualIndexes(concurrentConstraint, targets),
    ).rejects.toThrow('constraint ownership');
  });

  it('times out on a competing writer without removing the old index, then retries', async () => {
    if (version < 150000) return;
    const definition = schema('timeout');
    await create(definition, true);
    const targets = collectNullEqualIndexTargets({ model: definition });
    const writer = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `i2834_writer_${randomUUID()}`,
    });
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = writer.transaction(async (tx) => {
      await tx.query(
        `LOCK TABLE "${definition.tableName}" IN ROW EXCLUSIVE MODE`,
      );
      locked();
      await finish;
    });
    try {
      await ready;
      await expect(
        migrateNullEqualIndexes(db, targets, { lockTimeout: '50ms' }),
      ).rejects.toThrow();
    } finally {
      release();
      await writing;
      await writer.close?.();
    }
    expect(
      (await preflightNullEqualIndexes(db, targets)).indexes[0].state,
    ).toBe('pending');
    expect(
      (await migrateNullEqualIndexes(db, targets)).statements,
    ).toHaveLength(2);
  });

  it('rejects a same-name partial or reordered index rather than changing its semantics', async () => {
    if (version < 150000) return;
    const definition = schema('drift');
    await create(definition, true);
    const targets = collectNullEqualIndexTargets({ model: definition });
    const index = targets[0].index;
    await db.query(`DROP INDEX "${index}"`);
    await db.query(
      `CREATE UNIQUE INDEX "${index}" ON "${definition.tableName}" (tenant_id, slug, context) WHERE tenant_id IS NOT NULL`,
    );
    await expect(migrateNullEqualIndexes(db, targets)).rejects.toThrow(
      'shape differs',
    );
    await db.query(`DROP INDEX "${index}"`);
    await db.query(
      `CREATE UNIQUE INDEX "${index}" ON "${definition.tableName}" (slug, tenant_id, context)`,
    );
    await expect(migrateNullEqualIndexes(db, targets)).rejects.toThrow(
      'shape differs',
    );
  });
});
