/**
 * #4932: the planner probes live rows before it adds a per-subclass CHECK. When
 * the column the rule names is added by the same migration, the probe must not
 * query it (the column is not there yet): on PostgreSQL an undefined-column
 * error aborts a caller-owned transaction (SQLSTATE 25P02). Runs on PGlite
 * under `pnpm test:pglite`; skipped on the default SQLite run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type { SmartObjectDefinition } from '../../scanner/types.js';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';

const PKG = '@test4932/probe';
const TABLE = 'docs_4932_probe';
const STRICT = `${PKG}:StrictProbe`;

function def(
  className: string,
  fields: SmartObjectDefinition['fields'],
  parent?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${PKG}/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: parent ? {} : { tableStrategy: 'sti', tableName: TABLE },
    packageName: PKG,
    extends: parent ?? 'SmrtObject',
  } as SmartObjectDefinition;
}

/** The table's schema; `withPriority` adds the subtype-only required column. */
function schemaFor(
  restore: () => void,
  withPriority: boolean,
): SchemaDefinition {
  restore();
  const strictFields: SmartObjectDefinition['fields'] = withPriority
    ? { priority: { type: 'text', required: true } }
    : {};
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: `/${PKG}`,
        errors: [],
        objects: [
          def('BaseProbe', { title: { type: 'text' } }),
          def('StrictProbe', strictFields, 'BaseProbe'),
        ],
      },
    ],
    { packageName: PKG },
  );
  for (const [key, obj] of Object.entries(manifest.objects)) {
    ObjectRegistry.registerFromManifest(key, obj, PKG);
  }
  return ObjectRegistry.getAllSchemasAsDefinitions()[TABLE];
}

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  '#4932 check probe never queries a column the migration has yet to add',
  () => {
    let restoreAll: () => void;
    let reset: () => void;
    let db: Awaited<ReturnType<typeof getTestDatabase>>;
    const strategy = getDDLStrategy('postgres');

    beforeEach(async () => {
      restoreAll = snapshotObjectRegistryState();
      ObjectRegistry.clear();
      reset = () => {
        restoreAll();
        restoreAll = snapshotObjectRegistryState();
        ObjectRegistry.clear();
      };
      db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
    });
    afterEach(async () => {
      await db.close?.();
      restoreAll();
    });

    const insert = (type: string, slug: string) =>
      db.query(
        `INSERT INTO "${TABLE}" (id, slug, context, _meta_type, title) VALUES (gen_random_uuid(), $1, '', $2, 'x')`,
        [slug, type],
      );
    const plan = () =>
      new SchemaComparer(db, { engineHint: 'postgres' }).compare({
        [TABLE]: schemaFor(reset, true),
      });
    const statements = (diff: Awaited<ReturnType<typeof plan>>) =>
      getSQLFromDiff(diff).filter((s) => !s.startsWith('--'));

    it('plans and applies inside a caller-owned transaction on an empty table', async () => {
      await db.query(strategy.generateCreateTable(schemaFor(reset, false)));
      await db.query('BEGIN');
      const diff = await plan();
      for (const sql of statements(diff)) await db.query(sql);
      await db.query('COMMIT');
      await expect(insert(STRICT, 'a')).rejects.toThrow(/smrt_ck_/);
    });

    it('plans without a transaction on an empty table', async () => {
      await db.query(strategy.generateCreateTable(schemaFor(reset, false)));
      const diff = await plan();
      for (const sql of statements(diff)) await db.query(sql);
      await expect(insert(STRICT, 'a')).rejects.toThrow(/smrt_ck_/);
    });

    it('reports, and does not apply, the rule when rows of the subtype would hold NULL', async () => {
      await db.query(strategy.generateCreateTable(schemaFor(reset, false)));
      await insert(STRICT, 'a');
      await db.query('BEGIN');
      const diff = await plan();
      const check = diff.changes.find(
        (c: { alteration?: string }) => c.alteration === 'set_check',
      );
      expect(check?.sqlStatements).toBeUndefined();
      expect(check?.advisory?.message).toContain(`${TABLE}.priority`);
      for (const sql of statements(diff)) await db.query(sql);
      await db.query('COMMIT');
    });

    it('adds the rule when only rows of other classes exist', async () => {
      await db.query(strategy.generateCreateTable(schemaFor(reset, false)));
      await insert(`${PKG}:BaseProbe`, 'a');
      await db.query('BEGIN');
      const diff = await plan();
      for (const sql of statements(diff)) await db.query(sql);
      await db.query('COMMIT');
      await expect(insert(STRICT, 'b')).rejects.toThrow(/smrt_ck_/);
    });

    it('plans a backfill that names a column this migration adds, inside a caller-owned transaction', async () => {
      await db.query('CREATE TABLE bf_items (id TEXT PRIMARY KEY, name TEXT)');
      await db.query("INSERT INTO bf_items (id, name) VALUES ('i1', 'a')");
      await db.query('BEGIN');
      const diff = await new SchemaComparer(db, {
        engineHint: 'postgres',
      }).compare({
        bf_items: {
          tableName: 'bf_items',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            name: { type: 'TEXT' },
            added_now: { type: 'TEXT' },
            claim_key: {
              type: 'TEXT',
              notNull: true,
              backfill: "'k:' || added_now",
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      });
      const refused = diff.changes.find(
        (c: { name?: string }) => c.name === 'claim_key',
      );
      expect(refused?.advisory?.message).toMatch(/^bf_items\.claim_key /);
      // The transaction is still usable: the rest of the plan applies.
      for (const sql of statements(diff)) await db.query(sql);
      await db.query('COMMIT');
    });
  },
);
