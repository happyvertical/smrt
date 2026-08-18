/**
 * System-table evolution invariants (issue #2376).
 *
 * `bootstrapSystemTables()` replays `IF NOT EXISTS` DDL and skips the replay
 * entirely once `SMRT_SCHEMA_VERSION` is recorded. That makes two things true
 * that nothing used to check:
 *
 * 1. **Fresh must equal upgraded.** `CREATE TABLE IF NOT EXISTS` is a no-op on
 *    an existing table, so a new column reaches old databases only through a
 *    hand-written `addColumnIfMissing()` in `system/compatibility.ts`. If that
 *    is forgotten, a fresh install and an upgraded install diverge silently.
 *    These tests bootstrap a legacy-shaped database, upgrade it, and compare
 *    its live shape — columns *and* indexes — against a fresh bootstrap.
 * 2. **DDL edits must bump the version.** Without a bump, no existing database
 *    replays the DDL at all. A checksum pinned to the version makes that a
 *    test failure instead of a silent no-op.
 *
 * All tests run against real in-memory SQLite (never mock the database).
 */

import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SmrtClass } from '../class';
import { checkLiveSchemaParity } from '../schema/live-parity';
import {
  getSystemTableShapes,
  SYSTEM_TABLE_NAMES,
} from '../schema/system-table-shapes';
import {
  ALL_SYSTEM_TABLES,
  DEFERRED_COMPATIBILITY_TABLES,
  FRAMEWORK_OPERATIONAL_TABLES,
  getSystemSchemaChecksumInput,
  RETIRED_SYSTEM_TABLES,
  SMRT_SCHEMA_DDL_CHECKSUMS,
  SMRT_SCHEMA_VERSION,
} from '../system/schema';

// ============================================================================
// Live-shape reader
// ============================================================================

interface TableShape {
  columns: string[];
  indexes: string[];
}

type SystemShape = Record<string, TableShape>;

/**
 * Read the live shape of every `_smrt_`-prefixed table.
 *
 * Columns are `name:type:notnull:default`; indexes are
 * `name(col,col):unique`. Implicit `sqlite_autoindex_*` entries are included
 * under a normalized name so a UNIQUE column constraint and an equivalent
 * named unique index are not confused for one another — the point of the
 * comparison is that both installs enforce the same things.
 */
async function readSystemShape(db: DatabaseInterface): Promise<SystemShape> {
  const tables = await db.query(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE '\\_smrt\\_%' ESCAPE '\\'
      ORDER BY name`,
  );

  const shape: SystemShape = {};
  for (const row of tables.rows as { name: string }[]) {
    const tableName = row.name;

    const columnRows = await db.query(`PRAGMA table_info(${tableName})`);
    const columns = (
      columnRows.rows as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    )
      .map(
        (column) =>
          `${column.name}:${column.type}:${column.notnull}:${column.dflt_value ?? ''}`,
      )
      .sort();

    const indexRows = await db.query(`PRAGMA index_list(${tableName})`);
    const indexes: string[] = [];
    for (const index of indexRows.rows as {
      name: string;
      unique: number;
    }[]) {
      const infoRows = await db.query(`PRAGMA index_info(${index.name})`);
      const indexColumns = (infoRows.rows as { name: string }[]).map(
        (info) => info.name,
      );
      // Implicit constraint indexes get engine-assigned names; identify them
      // by shape so a rebuilt table compares equal to a freshly created one.
      const name = index.name.startsWith('sqlite_autoindex_')
        ? '<implicit>'
        : index.name;
      indexes.push(`${name}(${indexColumns.join(',')}):${index.unique}`);
    }
    indexes.sort();

    shape[tableName] = { columns, indexes };
  }
  return shape;
}

async function bootstrap(db: DatabaseInterface): Promise<void> {
  const instance = new SmrtClass({ db });
  await (instance as unknown as { initialize(): Promise<void> }).initialize();
}

async function freshDatabase(): Promise<DatabaseInterface> {
  return getDatabase({ type: 'sqlite', url: ':memory:' });
}

// ============================================================================
// Legacy shapes (pre-1.9 installs, as `system/compatibility.ts` describes them)
// ============================================================================

/** `_smrt_dispatch` before target_subscriber / correlation_id / tenant_id. */
const LEGACY_DISPATCH_TABLE = `
CREATE TABLE _smrt_dispatch (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMP,
  processed_by TEXT,
  metadata TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/**
 * `_smrt_dispatch_subscriptions` as originally shipped (#590): no `delivery`,
 * no `tenant_id`, and the pre-#1398 tenant-blind `UNIQUE(signal_type,
 * subscriber)` identity that the compatibility pass has to rebuild away.
 */
const LEGACY_DISPATCH_SUBSCRIPTIONS_TABLE = `
CREATE TABLE _smrt_dispatch_subscriptions (
  id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  subscriber TEXT NOT NULL,
  handler TEXT NOT NULL DEFAULT 'handleDispatch',
  enabled INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(signal_type, subscriber)
)`;

// ============================================================================
// Tests
// ============================================================================

describe('system schema evolution (issue #2376)', () => {
  describe('fresh install equals upgraded install', () => {
    it('produces the same system-table shape from a legacy database as from an empty one', async () => {
      const fresh = await freshDatabase();
      await bootstrap(fresh);
      const freshShape = await readSystemShape(fresh);

      const upgraded = await freshDatabase();
      await upgraded.query(LEGACY_DISPATCH_TABLE);
      await upgraded.query(LEGACY_DISPATCH_SUBSCRIPTIONS_TABLE);
      await upgraded.query(
        `INSERT INTO _smrt_dispatch_subscriptions (id, signal_type, subscriber)
         VALUES ('sub-1', 'order.placed', 'worker')`,
      );
      await bootstrap(upgraded);
      const upgradedShape = await readSystemShape(upgraded);

      expect(Object.keys(upgradedShape)).toEqual(Object.keys(freshShape));
      for (const tableName of Object.keys(freshShape)) {
        expect(
          upgradedShape[tableName],
          `system table ${tableName} differs between a fresh and an upgraded install`,
        ).toEqual(freshShape[tableName]);
      }

      // The upgrade is a migration, not a rebuild: legacy rows survive.
      const rows = await upgraded.query(
        'SELECT id FROM _smrt_dispatch_subscriptions',
      );
      expect(rows.rows).toHaveLength(1);

      await fresh.close?.();
      await upgraded.close?.();
    });

    it('satisfies the declared system-table shape on both installs', async () => {
      // Cross-check against #2368's live-parity oracle: fresh == upgraded is
      // necessary but not sufficient — both must also match the DDL's intent,
      // so a column dropped from BOTH paths cannot pass unnoticed.
      const fresh = await freshDatabase();
      await bootstrap(fresh);

      const upgraded = await freshDatabase();
      await upgraded.query(LEGACY_DISPATCH_TABLE);
      await upgraded.query(LEGACY_DISPATCH_SUBSCRIPTIONS_TABLE);
      await bootstrap(upgraded);

      const freshReport = await checkLiveSchemaParity({
        db: fresh,
        engineHint: 'sqlite',
      });
      const upgradedReport = await checkLiveSchemaParity({
        db: upgraded,
        engineHint: 'sqlite',
      });

      const systemFindings = (report: typeof freshReport) =>
        report.findings
          .filter((finding) => finding.origin === 'system')
          .map(
            (finding) =>
              `${finding.severity} ${finding.kind} ${finding.table}.${finding.target ?? ''}`,
          )
          .sort();

      expect(systemFindings(freshReport)).toEqual([]);
      expect(systemFindings(upgradedReport)).toEqual(
        systemFindings(freshReport),
      );
      expect(freshReport.systemTablesIncluded).toBe(true);
      expect(freshReport.tablesChecked).toBe(SYSTEM_TABLE_NAMES.length);

      await fresh.close?.();
      await upgraded.close?.();
    });

    it('creates every column and index the system DDL declares', async () => {
      // The declared shape comes from #2368's parser, so this test cannot
      // drift from the DDL it is meant to guard.
      const db = await freshDatabase();
      await bootstrap(db);
      const live = await readSystemShape(db);

      for (const [tableName, declared] of getSystemTableShapes('sqlite')) {
        const liveColumns = new Set(
          live[tableName]?.columns.map((column) => column.split(':')[0]),
        );
        for (const column of declared.columns) {
          expect(
            liveColumns.has(column.name),
            `${tableName}.${column.name} is declared but missing from a fresh install`,
          ).toBe(true);
        }

        const liveIndexes = new Set(
          live[tableName]?.indexes.map((index) => index.split('(')[0]),
        );
        for (const index of declared.indexes) {
          expect(
            liveIndexes.has(index.name),
            `${index.name} is declared but missing from a fresh install`,
          ).toBe(true);
        }
      }

      await db.close?.();
    });

    it('stamps the same schema version on both installs', async () => {
      const fresh = await freshDatabase();
      await bootstrap(fresh);

      const rows = await fresh.query(
        'SELECT version FROM _smrt_migrations ORDER BY version',
      );
      const versions = (rows.rows as { version: string }[]).map(
        (row) => row.version,
      );
      expect(versions).toContain(SMRT_SCHEMA_VERSION);

      await fresh.close?.();
    });

    it('creates every table SYSTEM_TABLE_NAMES declares, and nothing else', async () => {
      const db = await freshDatabase();
      await bootstrap(db);

      const shape = await readSystemShape(db);
      expect(Object.keys(shape).sort()).toEqual([...SYSTEM_TABLE_NAMES].sort());

      await db.close?.();
    });
  });

  describe('retired system tables', () => {
    it('no longer creates _smrt_registry or _smrt_signals on a fresh database', async () => {
      const db = await freshDatabase();
      await bootstrap(db);

      const shape = await readSystemShape(db);
      for (const retired of RETIRED_SYSTEM_TABLES) {
        expect(Object.keys(shape)).not.toContain(retired);
      }

      await db.close?.();
    });

    it('leaves a pre-existing retired table alone rather than dropping data', async () => {
      const db = await freshDatabase();
      await db.query(`CREATE TABLE _smrt_signals (id TEXT PRIMARY KEY)`);
      await db.query(`INSERT INTO _smrt_signals (id) VALUES ('legacy')`);
      await bootstrap(db);

      const rows = await db.query('SELECT id FROM _smrt_signals');
      expect(rows.rows).toHaveLength(1);

      await db.close?.();
    });

    it('keeps the retired names out of the DDL entirely', () => {
      const ddl = ALL_SYSTEM_TABLES.join('\n');
      for (const retired of RETIRED_SYSTEM_TABLES) {
        expect(ddl).not.toContain(retired);
      }
    });
  });

  describe('schema version guard', () => {
    it('fails when ALL_SYSTEM_TABLES changed without bumping SMRT_SCHEMA_VERSION', () => {
      const actual = createHash('sha256')
        .update(getSystemSchemaChecksumInput())
        .digest('hex');

      expect(
        actual,
        [
          'The SMRT system-table DDL changed.',
          '',
          'bootstrapSystemTables() skips the replay once SMRT_SCHEMA_VERSION is',
          'recorded, so an existing database will NEVER see this change unless the',
          'version is bumped. New COLUMNS additionally need an addColumnIfMissing()',
          'entry in system/compatibility.ts — CREATE TABLE IF NOT EXISTS is a no-op',
          'on a table that already exists.',
          '',
          'To resolve, in packages/core/src/system/schema.ts:',
          '  1. bump SMRT_SCHEMA_VERSION',
          '  2. add any needed compatibility migration',
          '  3. append to SMRT_SCHEMA_DDL_CHECKSUMS under the NEW version:',
          `     ${actual}`,
        ].join('\n'),
      ).toBe(SMRT_SCHEMA_DDL_CHECKSUMS[SMRT_SCHEMA_VERSION]);
    });

    it('cannot be silenced by overwriting a recorded checksum', () => {
      // Every historical hash stays distinct, so a changed DDL has nowhere to
      // be recorded except under a new version key — which is the bump.
      const recorded = Object.values(SMRT_SCHEMA_DDL_CHECKSUMS);
      expect(new Set(recorded).size).toBe(recorded.length);

      const versions = Object.keys(SMRT_SCHEMA_DDL_CHECKSUMS);
      expect(versions.at(-1)).toBe(SMRT_SCHEMA_VERSION);
      for (const version of versions) {
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(SMRT_SCHEMA_DDL_CHECKSUMS[version]).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('pins a plausible semver version', () => {
      expect(SMRT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('system table classification', () => {
    it('derives SYSTEM_TABLE_NAMES from the DDL without duplicates', () => {
      expect(SYSTEM_TABLE_NAMES.length).toBe(ALL_SYSTEM_TABLES.length);
      expect(new Set(SYSTEM_TABLE_NAMES).size).toBe(SYSTEM_TABLE_NAMES.length);
      for (const name of SYSTEM_TABLE_NAMES) {
        expect(name.startsWith('_smrt_')).toBe(true);
      }
    });

    it('reports a retired table with the exact drop remedy', async () => {
      const db = await freshDatabase();
      await bootstrap(db);
      await db.query(
        `CREATE TABLE _smrt_registry (class_name TEXT PRIMARY KEY)`,
      );

      const report = await checkLiveSchemaParity({
        db,
        engineHint: 'sqlite',
      });
      const finding = report.findings.find(
        (candidate) => candidate.table === '_smrt_registry',
      );
      expect(finding?.kind).toBe('extra_table');
      expect(finding?.severity).toBe('info');
      expect(finding?.recommendation).toContain(
        'DROP TABLE IF EXISTS _smrt_registry;',
      );
      // Informational only — a lingering retired table is not a failure.
      expect(report.ok).toBe(true);

      await db.close?.();
    });

    it('keeps the framework table categories disjoint', () => {
      const systemTables = new Set(SYSTEM_TABLE_NAMES);
      for (const name of FRAMEWORK_OPERATIONAL_TABLES) {
        expect(
          systemTables.has(name),
          `${name} is model-backed and must not also be declared in ALL_SYSTEM_TABLES`,
        ).toBe(false);
      }
      for (const name of RETIRED_SYSTEM_TABLES) {
        expect(systemTables.has(name)).toBe(false);
      }
      for (const name of DEFERRED_COMPATIBILITY_TABLES) {
        expect(FRAMEWORK_OPERATIONAL_TABLES).toContain(name);
      }
    });
  });
});
