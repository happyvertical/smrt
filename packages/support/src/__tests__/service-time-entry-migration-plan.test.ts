/**
 * #3288 migration plan on the CLI's manifest path: `smrt db:migrate` /
 * `db:status` register each package's built manifest and diff the merged
 * table definitions against the live database. With smrt-timesheets owning
 * the base entry and smrt-support adding `caseId` / `specialistId`, a
 * `service_time_entries` table built from the pre-move schema must only add
 * framework sync metadata (#4673), whichever order the manifests load in.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getPendingSchemaStatements } from '@happyvertical/smrt-core/migrations';
import {
  collectManifestTables,
  type ManifestSchemaLike,
  renderCollectedManifestTable,
} from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TABLE = 'service_time_entries';
const require = createRequire(import.meta.url);

/** DDL whose target is `table` (not one that merely references it). */
function targets(statement: string, table: string): boolean {
  return new RegExp(
    `(?:TABLE(?: IF NOT EXISTS)?|ON)\\s+"?${table}"?[\\s(]`,
  ).test(statement);
}

function builtManifest(packageName: string) {
  return JSON.parse(
    readFileSync(require.resolve(`${packageName}/manifest.json`), 'utf8'),
  );
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/pre-3288-service-time-entry-schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { schemas: Record<string, ManifestSchemaLike> };

const PACKAGES = [
  '@happyvertical/smrt-timesheets',
  '@happyvertical/smrt-projects',
  '@happyvertical/smrt-support',
];

describe('service_time_entries migration plan after #3288', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    ObjectRegistry.clear();
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const tables = collectManifestTables(
      Object.entries(fixture.schemas).map(([source, schema]) => ({
        schema,
        source,
      })),
    );
    for (const table of tables.values()) {
      const ddl = renderCollectedManifestTable(table, 'sqlite');
      await db.query(ddl.createTable);
      for (const index of ddl.indexes) await db.query(index);
    }
  });

  afterEach(async () => {
    ObjectRegistry.clear();
    await db.close?.();
  });

  for (const order of [PACKAGES, [...PACKAGES].reverse()]) {
    it(`plans one table family with only additive sync DDL (${order.map((name) => name.split('smrt-')[1]).join(' → ')})`, async () => {
      for (const packageName of order) {
        ObjectRegistry.registerPackageManifest(builtManifest(packageName));
      }

      const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
      expect(Object.keys(schemas[TABLE].columns)).toEqual(
        expect.arrayContaining(['case_id', 'specialist_id', 'work_ref_id']),
      );

      const plan = async () => {
        const pending = await getPendingSchemaStatements(db, {
          engineHint: 'sqlite',
        });
        expect(
          pending.unactionableChanges.filter(
            (change) => change.table === TABLE,
          ),
        ).toEqual([]);
        expect(
          pending.diff.changes.filter(
            (change) => change.table === TABLE && change.type === 'drop_index',
          ),
        ).toEqual([]);
        return pending.statements.filter((statement) =>
          targets(statement, TABLE),
        );
      };
      const statements = await plan();
      expect(statements).toEqual([
        `ALTER TABLE "${TABLE}" ADD COLUMN "_sync_origin_device_id" TEXT`,
        `ALTER TABLE "${TABLE}" ADD COLUMN "_sync_revision" INTEGER`,
      ]);
      for (const statement of statements) await db.query(statement);
      expect(await plan()).toEqual([]);
    });
  }
});
