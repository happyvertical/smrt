/**
 * PostgreSQL transaction hydration contract for issue #2070.
 *
 * Runs only in the dedicated disposable PostgreSQL shard with
 * NODE_OPTIONS=--trace-deprecation so pg's concurrent-query warning is fatal
 * to the assertion below rather than being hidden in test output.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2070_postgres_hydration_probes';

@smrt({ tableName: 'issue_2070_postgres_hydration_probes' })
class Issue2070PostgresHydrationProbe extends SmrtObject {
  @field()
  position: number = 0;

  override async initialize(): Promise<this> {
    await super.initialize();
    if (this.isPersisted && this.id) {
      await this.db.get(this.tableName, { id: this.id });
    }
    return this;
  }
}

class Issue2070PostgresHydrationProbeCollection extends SmrtCollection<Issue2070PostgresHydrationProbe> {
  static readonly _itemClass = Issue2070PostgresHydrationProbe;
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('PostgreSQL transaction hydration (#2070)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-hydration-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0]);

    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    const registration = ObjectRegistry.getClassByConstructor(
      Issue2070PostgresHydrationProbe,
    );
    const className =
      registration?.qualifiedName ||
      registration?.name ||
      Issue2070PostgresHydrationProbe.name;
    const schema = ObjectRegistry.getSchema(className);
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!schema || !ddl) throw new Error(`Missing schema for ${className}`);
    await db.query(ddl);
    for (const indexSql of getDDLStrategy('postgres').generateIndexes(schema)) {
      await db.query(indexSql);
    }
  });

  afterAll(async () => {
    try {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await db?.close?.();
    }
  });

  it('does not overlap initialize() queries on one transaction client', async () => {
    await db.query(`TRUNCATE TABLE "${TABLE}"`);

    const warnings: Error[] = [];
    const captureWarning = (warning: Error): void => {
      if (
        /client\.query\(\).*already executing a query/i.test(warning.message)
      ) {
        warnings.push(warning);
      }
    };
    process.on('warning', captureWarning);

    try {
      await db.transaction(async (tx) => {
        const probes = await Issue2070PostgresHydrationProbeCollection.create({
          db: tx,
        });
        for (const position of [1, 2, 3]) {
          const id = randomUUID();
          await tx.insert(TABLE, {
            id,
            slug: id,
            context: '',
            created_at: new Date(),
            updated_at: new Date(),
            position,
          });
        }

        const rows = await probes.list({ orderBy: 'position ASC' });
        expect(rows.map((row) => row.position)).toEqual([1, 2, 3]);
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).toEqual([]);
    } finally {
      process.off('warning', captureWarning);
    }
  });
});
