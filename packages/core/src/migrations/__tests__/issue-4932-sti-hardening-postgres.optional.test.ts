/**
 * #4932 on PostgreSQL: a shared-table subclass that makes a field required is
 * enforced by the database with a CHECK that holds for every other class.
 * Needs `SMRT_TEST_POSTGRES_URL`; not run in the default suite.
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
const PKG = '@test4932/pg';
const TABLE = 'docs_4932_pg';
const STRICT = `${PKG}:StrictDoc4932Pg`;
const LOOSE = `${PKG}:LooseDoc4932Pg`;

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

/**
 * The table's schema, with or without the hardening subclass. The registry
 * holds one version of the code at a time, so each call starts it afresh: the
 * migration plan is built from what is registered, as in a real deployment.
 */
function schemaFor(hardened: boolean): SchemaDefinition {
  resetRegistry();
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: `/${PKG}`,
        errors: [],
        objects: [
          def('Doc4932Pg', { title: { type: 'text' } }),
          def(
            'StrictDoc4932Pg',
            { title: { type: 'text', required: hardened } },
            'Doc4932Pg',
          ),
          def('LooseDoc4932Pg', { body: { type: 'text' } }, 'Doc4932Pg'),
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

let resetRegistry = () => {};

describe.skipIf(!pgUrl)('#4932 shared-table class rule on PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let restore: () => void;
  const strategy = getDDLStrategy('postgres');

  beforeAll(async () => {
    db = await getDatabase({ type: 'postgres', url: pgUrl });
  });
  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await db.close?.();
  });
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    resetRegistry = () => {
      restore();
      restore = snapshotObjectRegistryState();
    };
    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  });
  afterEach(() => restore());

  const insert = (type: string, slug: string, title: string | null) =>
    db.query(
      `INSERT INTO "${TABLE}" (id, slug, context, _meta_type, title) VALUES (gen_random_uuid(), $1, '', $2, $3)`,
      [slug, type, title],
    );

  const diffOf = (schema: SchemaDefinition) =>
    new SchemaComparer(db, { engineHint: 'postgres' }).compare({
      [TABLE]: schema,
    });

  async function apply(diff: Awaited<ReturnType<typeof diffOf>>) {
    for (const sql of getSQLFromDiff(diff).filter((s) => !s.startsWith('--'))) {
      await db.query(sql);
    }
  }

  it('a new table refuses a NULL for the strict class only', async () => {
    const schema = schemaFor(true);
    await db.query(strategy.generateCreateTable(schema));
    await expect(insert(STRICT, 'a', null)).rejects.toThrow(/smrt_ck_/);
    await insert(STRICT, 'b', 'x');
    await insert(LOOSE, 'c', null);
    await insert(`${PKG}:Doc4932Pg`, 'd', null);
  });

  it('an existing table gains the rule when migrated, then reports no changes', async () => {
    await db.query(strategy.generateCreateTable(schemaFor(false)));
    await insert(STRICT, 'a', null);
    const hardened = schemaFor(true);
    // The existing NULL row breaks the rule: reported, nothing is applied.
    const blocked = await diffOf(hardened);
    const blockedChange = blocked.changes.find(
      (c: { alteration?: string }) => c.alteration === 'set_check',
    );
    expect(blockedChange?.advisory?.message).toContain(`${TABLE}.title`);
    await db.query(`DELETE FROM "${TABLE}"`);
    await apply(await diffOf(hardened));
    await expect(insert(STRICT, 'b', null)).rejects.toThrow(/smrt_ck_/);
    await insert(LOOSE, 'c', null);
    expect(getSQLFromDiff(await diffOf(hardened))).toEqual([]);
  });

  it('dropping the rule from the code drops the constraint', async () => {
    await db.query(strategy.generateCreateTable(schemaFor(true)));
    const relaxed = schemaFor(false);
    await apply(await diffOf(relaxed));
    await insert(STRICT, 'a', null);
  });
});
