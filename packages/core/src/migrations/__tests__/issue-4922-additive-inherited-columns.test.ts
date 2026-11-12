/**
 * #4922 row 5: a database created before an own-table subclass carried its
 * ancestors' fields only gains columns when it is migrated. A same-named
 * subclass's table already holds them and reports nothing.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type { SmartObjectDefinition } from '../../scanner/types.js';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';

const PKG = '@test4922/migrate';

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
          def('Customer', {
            name: {
              type: 'text',
              required: true,
              ...(nameDefault !== undefined ? { default: nameDefault } : {}),
            },
            phone: { type: 'text', required: true, default: '' },
            nick: { type: 'text' },
          }),
          def('VipCustomer', { accountManager: { type: 'text' } }, 'Customer'),
        ],
      },
    ],
    { packageName: PKG },
  );
  for (const [key, obj] of Object.entries(manifest.objects)) {
    ObjectRegistry.registerFromManifest(key, obj, PKG);
  }
  return ObjectRegistry.getAllSchemasAsDefinitions().vip_customers;
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

async function apply(
  db: Awaited<ReturnType<typeof getDatabase>>,
  diff: Awaited<ReturnType<SchemaComparer['compare']>>,
) {
  // Comment-only entries are reports, not statements.
  for (const sql of getSQLFromDiff(diff).filter((s) => !s.startsWith('--'))) {
    await db.query(sql);
  }
}

describe('#4922 migrating a database created before the fix', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  async function create(populated: boolean, nameDefault?: string) {
    // Open the database first: the SQLite adapter creates tables for the
    // classes registered when it opens.
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const current = vipSchema(nameDefault);
    const strategy = getDDLStrategy('sqlite');
    const old = oldSchema(current);
    await db.query(strategy.generateCreateTable(old));
    if (populated) {
      await db.query(
        `INSERT INTO vip_customers (id, slug, account_manager) VALUES ('1', 'a', 'Grace')`,
      );
    }
    return { db, current };
  }

  const diffOf = async (
    db: Awaited<ReturnType<typeof getDatabase>>,
    s: SchemaDefinition,
  ) =>
    new SchemaComparer(db, { engineHint: 'sqlite' }).compare({
      vip_customers: s,
    });

  it('an empty table gains every inherited column, then reports no changes', async () => {
    const { db, current } = await create(false);
    const diff = await diffOf(db, current);
    const added = diff.changes
      .filter((c: { type: string }) => c.type === 'add_column')
      .map((c: { name?: string }) => c.name)
      .sort();
    expect(added).toEqual(['name', 'nick', 'phone']);
    await apply(db, diff);
    const cols = (
      await db.query('SELECT name, "notnull" AS nn FROM pragma_table_info(?)', [
        'vip_customers',
      ])
    ).rows as Array<{ name: string; nn: number }>;
    expect(cols.find((c) => c.name === 'name')?.nn).toBe(1);
    expect(getSQLFromDiff(await diffOf(db, current))).toEqual([]);
  });

  it('a populated table: a required column with a default is added NOT NULL and rows take the default', async () => {
    const { db, current } = await create(true, 'anon');
    const diff = await diffOf(db, current);
    await apply(db, diff);
    const row = (
      await db.query('SELECT phone, account_manager FROM vip_customers')
    ).rows[0] as Record<string, unknown>;
    expect(row).toEqual({ phone: '', account_manager: 'Grace' });
    expect((await db.query('SELECT name FROM vip_customers')).rows[0]).toEqual({
      name: 'anon',
    });
    const cols = (
      await db.query('SELECT name, "notnull" AS nn FROM pragma_table_info(?)', [
        'vip_customers',
      ])
    ).rows as Array<{ name: string; nn: number }>;
    expect(cols.find((c) => c.name === 'phone')?.nn).toBe(1);
  });

  it('a populated table: a required column with no default is reported, and nothing else is lost', async () => {
    const { db, current } = await create(true);
    const diff = await diffOf(db, current);
    const notAdded = diff.changes.filter(
      (c: { type: string; name?: string }) =>
        c.type === 'alter_column' && c.name === 'name',
    );
    expect(notAdded).toHaveLength(1);
    expect(notAdded[0].advisory?.message).toContain('vip_customers.name');
    expect(notAdded[0].advisory?.message).toContain('was not added');
    await apply(db, diff);
    const row = (await db.query('SELECT account_manager FROM vip_customers'))
      .rows[0] as Record<string, unknown>;
    expect(row.account_manager).toBe('Grace');
    const names = (
      await db.query('SELECT name FROM pragma_table_info(?)', ['vip_customers'])
    ).rows.map((r: Record<string, unknown>) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['nick', 'phone', 'account_manager']),
    );
    expect(names).not.toContain('name');
  });

  it('a table that already holds the inherited columns reports no changes', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const current = vipSchema();
    const strategy = getDDLStrategy('sqlite');
    await db.query(strategy.generateCreateTable(current));
    for (const sql of strategy.generateIndexes(current)) await db.query(sql);
    expect(getSQLFromDiff(await diffOf(db, current))).toEqual([]);
  });
});
