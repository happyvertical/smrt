/**
 * #4922 row 5 on PostgreSQL: a database created before an own-table subclass
 * carried its ancestors' fields only gains columns when it is migrated. The
 * SQLite cases live in `issue-4922-additive-inherited-columns.test.ts`.
 */
import { getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type { SmartObjectDefinition } from '../../scanner/types.js';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const PKG = '@test4922/migratepg';
const TABLE = 'vip_client4922s';

function def(
  className: string,
  fields: SmartObjectDefinition['fields'],
  extendsName?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${PKG}/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: {},
    packageName: PKG,
    extends: extendsName ?? 'SmrtObject',
  } as SmartObjectDefinition;
}

function vipSchema(nameDefault?: string): SchemaDefinition {
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: `/${PKG}`,
        errors: [],
        objects: [
          def('Client4922', {
            name: {
              type: 'text',
              required: true,
              ...(nameDefault !== undefined ? { default: nameDefault } : {}),
            },
            phone: { type: 'text', required: true, default: '' },
            nick: { type: 'text' },
          }),
          def(
            'VipClient4922',
            { accountManager: { type: 'text' } },
            'Client4922',
          ),
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

/** The schema as an older smrt generated it: own columns only. */
function oldSchema(current: SchemaDefinition): SchemaDefinition {
  const inherited = new Set(['name', 'phone', 'nick']);
  return {
    ...current,
    ddl: '',
    columns: Object.fromEntries(
      Object.entries(current.columns).filter(([c]) => !inherited.has(c)),
    ),
  };
}

describe.skipIf(!pgUrl)(
  '#4922 migrating a PostgreSQL database created before the fix',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;
    let restore: () => void;

    beforeAll(async () => {
      db = await getDatabase({ type: 'postgres', url: pgUrl });
    });
    afterAll(async () => {
      await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      await db.close?.();
    });
    beforeEach(async () => {
      restore = snapshotObjectRegistryState();
      await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    });
    afterEach(() => restore());

    const strategy = getDDLStrategy('postgres');

    async function create(populated: boolean, nameDefault?: string) {
      const current = vipSchema(nameDefault);
      await db.query(strategy.generateCreateTable(oldSchema(current)));
      if (populated) {
        await db.query(
          `INSERT INTO "${TABLE}" (id, slug, account_manager) VALUES (gen_random_uuid(), 'a', 'Grace')`,
        );
      }
      return current;
    }

    const diffOf = (schema: SchemaDefinition) =>
      new SchemaComparer(db, { engineHint: 'postgres' }).compare({
        [TABLE]: schema,
      });

    async function apply(diff: Awaited<ReturnType<typeof diffOf>>) {
      // Comment-only entries are reports, not statements.
      for (const sql of getSQLFromDiff(diff).filter(
        (s) => !s.startsWith('--'),
      )) {
        await db.query(sql);
      }
    }

    async function columns(): Promise<Record<string, boolean>> {
      const result = await db.query(
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${TABLE}'`,
      );
      return Object.fromEntries(
        (result.rows as Array<Record<string, string>>).map((row) => [
          row.column_name,
          row.is_nullable === 'NO',
        ]),
      );
    }

    it('an empty table gains every inherited column, then reports no changes', async () => {
      const current = await create(false);
      const diff = await diffOf(current);
      const added = diff.changes
        .filter((c: { type: string }) => c.type === 'add_column')
        .map((c: { name?: string }) => c.name)
        .sort();
      expect(added).toEqual(['name', 'nick', 'phone']);
      await apply(diff);
      const cols = await columns();
      expect(cols.name).toBe(true);
      expect(cols.phone).toBe(true);
      expect(cols.nick).toBe(false);
      expect(getSQLFromDiff(await diffOf(current))).toEqual([]);
    });

    it('a populated table: a required column with a default is added NOT NULL and rows take the default', async () => {
      const current = await create(true, 'anon');
      await apply(await diffOf(current));
      const row = (
        await db.query(`SELECT name, phone, account_manager FROM "${TABLE}"`)
      ).rows[0] as Record<string, unknown>;
      expect(row).toEqual({
        name: 'anon',
        phone: '',
        account_manager: 'Grace',
      });
      const cols = await columns();
      expect(cols.name).toBe(true);
      expect(cols.phone).toBe(true);
      expect(getSQLFromDiff(await diffOf(current))).toEqual([]);
    });

    it('a populated table: a required column with no default is reported, and nothing else is lost', async () => {
      const current = await create(true);
      const diff = await diffOf(current);
      const notAdded = diff.changes.filter(
        (c: { type: string; name?: string }) =>
          c.type === 'alter_column' && c.name === 'name',
      );
      expect(notAdded).toHaveLength(1);
      expect(notAdded[0].advisory?.message).toContain(`${TABLE}.name`);
      expect(notAdded[0].advisory?.message).toContain('was not added');
      await apply(diff);
      const row = (await db.query(`SELECT account_manager FROM "${TABLE}"`))
        .rows[0] as Record<string, unknown>;
      expect(row.account_manager).toBe('Grace');
      const cols = await columns();
      expect(Object.keys(cols)).toEqual(
        expect.arrayContaining(['nick', 'phone', 'account_manager']),
      );
      expect(cols).not.toHaveProperty('name');
    });

    it('a table that already holds the inherited columns reports no changes', async () => {
      const current = vipSchema();
      await db.query(strategy.generateCreateTable(current));
      for (const sql of strategy.generateIndexes(current)) await db.query(sql);
      expect(getSQLFromDiff(await diffOf(current))).toEqual([]);
    });
  },
);
