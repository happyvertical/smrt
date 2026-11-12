/**
 * #4932: a shared-table subclass that makes a field required is enforced by
 * the database on PostgreSQL, by a CHECK that holds for every other class.
 *
 * The live PostgreSQL behaviour is in
 * `migrations/__tests__/issue-4932-sti-hardening-postgres.optional.test.ts`
 * (PGlite is not installed here). This file covers the generated schema, the
 * DDL text per engine and the migration differ with a scripted catalog.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { getDDLStrategy } from './ddl/index.js';
import { manifestSchemaToDefinition } from './manifest-schema.js';
import { STI_CHECK_PREFIX, stiHardeningChecks } from './sti-hardening.js';
import type { SchemaDefinition } from './types.js';

const PKG = '@test4932/app';
const TABLE = 'docs_4932';

function def(
  className: string,
  fields: Record<string, FieldDefinition>,
  parent?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${PKG}/src/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: parent ? {} : { tableStrategy: 'sti', tableName: TABLE },
    packageName: PKG,
    extends: parent ?? 'SmrtObject',
  } as SmartObjectDefinition;
}

function build(objects: SmartObjectDefinition[]): SmartObjectManifest {
  return new ManifestGenerator().generateManifest(
    [{ filePath: `/${PKG}/src`, objects, errors: [] }],
    { packageName: PKG },
  );
}

const optionalTitle: Record<string, FieldDefinition> = {
  title: { type: 'text' },
};

describe('stiHardeningChecks (#4932)', () => {
  const toColumn = (name: string) => name;

  it('covers a field a subclass requires and the base leaves optional', () => {
    const checks = stiHardeningChecks(
      TABLE,
      toColumn,
      [['title', { type: 'text' }]],
      [
        {
          className: 'Strict',
          fields: [['title', { type: 'text', required: true }]],
        },
        { className: 'Loose', fields: [['title', { type: 'text' }]] },
      ],
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].expression).toBe(
      `_meta_type NOT IN ('Strict') OR "title" IS NOT NULL`,
    );
    expect(checks[0].name.startsWith(STI_CHECK_PREFIX)).toBe(true);
    expect(checks[0].name.length).toBeLessThanOrEqual(63);
  });

  it('lists every requiring class in one rule, in a stable order', () => {
    const fields = [['title', { type: 'text', required: true }]] as const;
    const a = stiHardeningChecks(
      TABLE,
      toColumn,
      [],
      [
        { className: 'B', fields },
        { className: 'A', fields },
      ],
    );
    const b = stiHardeningChecks(
      TABLE,
      toColumn,
      [],
      [
        { className: 'A', fields },
        { className: 'B', fields },
      ],
    );
    expect(a).toEqual(b);
    expect(a[0].expression).toContain(`NOT IN ('A', 'B')`);
  });

  it('leaves out a field the base already requires, an optional one, and a nullable one', () => {
    const checks = stiHardeningChecks(
      TABLE,
      toColumn,
      [['code', { type: 'text', required: true }]],
      [
        {
          className: 'Strict',
          fields: [
            ['code', { type: 'text', required: true }],
            [
              'note',
              { type: 'text', required: true, _meta: { nullable: true } },
            ],
            ['memo', { type: 'text', required: false }],
            ['tags', { type: 'manyToMany', required: true }],
          ],
        },
      ],
    );
    expect(checks).toEqual([]);
  });

  it('escapes a class name with a quote', () => {
    const [check] = stiHardeningChecks(
      TABLE,
      toColumn,
      [],
      [
        {
          className: "O'Neil",
          fields: [['x', { type: 'text', required: true }]],
        },
      ],
    );
    expect(check.expression).toContain(`'O''Neil'`);
  });
});

describe('shared-table schema from the manifest (#4932)', () => {
  const manifest = build([
    def('Doc4932', { ...optionalTitle, body: { type: 'text' } }),
    def(
      'StrictDoc4932',
      { title: { type: 'text', required: true } },
      'Doc4932',
    ),
    def('StrictChild4932', { extra: { type: 'text' } }, 'StrictDoc4932'),
    def('LooseDoc4932', { body: { type: 'text' } }, 'Doc4932'),
  ]);
  const schema = manifest.objects[`${PKG}:Doc4932`].schema;

  it('puts one check on the shared table, listing the class and its descendant', () => {
    expect(schema?.checks).toHaveLength(1);
    const [check] = schema?.checks ?? [];
    expect(check.columns).toEqual(['title']);
    expect(check.expression).toBe(
      `_meta_type NOT IN ('${PKG}:StrictChild4932', '${PKG}:StrictDoc4932') OR "title" IS NOT NULL`,
    );
  });

  it('leaves every column nullable', () => {
    expect(schema?.columns.title.notNull).toBeFalsy();
  });

  it('a manifest without a hardening has no checks key', () => {
    const plain = build([
      def('Doc4932', optionalTitle),
      def('Other4932', { body: { type: 'text' } }, 'Doc4932'),
    ]);
    expect(plain.objects[`${PKG}:Doc4932`].schema).not.toHaveProperty('checks');
  });

  it('PostgreSQL creates the table with the constraint; SQLite and DuckDB do not', () => {
    const definition = manifestSchemaToDefinition({
      ...(schema as NonNullable<typeof schema>),
      tableName: TABLE,
    });
    expect(definition.checks).toHaveLength(1);
    const pg = getDDLStrategy('postgres').generateCreateTable(definition);
    expect(pg).toContain(
      `CONSTRAINT "${definition.checks?.[0].name}" CHECK (_meta_type NOT IN`,
    );
    for (const engine of ['sqlite', 'duckdb'] as const) {
      expect(
        getDDLStrategy(engine).generateCreateTable(definition),
      ).not.toContain('CHECK (_meta_type');
    }
  });
});

describe('shared-table check in the migration differ (#4932)', () => {
  const manifest = build([
    def('Doc4932', optionalTitle),
    def(
      'StrictDoc4932',
      { title: { type: 'text', required: true } },
      'Doc4932',
    ),
  ]);
  const definition: SchemaDefinition = manifestSchemaToDefinition({
    ...(manifest.objects[`${PKG}:Doc4932`].schema as NonNullable<
      SmartObjectDefinition['schema']
    >),
    tableName: TABLE,
  });
  const declared = definition.checks?.[0];
  if (!declared) throw new Error('fixture has no check');

  type Change = {
    type: string;
    name?: string;
    alteration?: string;
    sqlStatements?: string[];
    advisory?: { message: string };
  };
  type Probe = {
    compareTableChecks(
      table: string,
      schema: SchemaDefinition,
    ): Promise<Change[]>;
  };

  function comparer(options: { live: string[]; violating?: boolean }) {
    const queries: string[] = [];
    const db = {
      url: 'postgres://localhost/test',
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_constraint'))
          return { rows: options.live.map((name) => ({ name })) };
        if (sql.includes('WHERE NOT ('))
          return { rows: options.violating ? [{ '?column?': 1 }] : [] };
        return { rows: [] };
      },
    } as unknown as DatabaseInterface;
    return {
      queries,
      run: () =>
        (
          new SchemaComparer(db, {
            engineHint: 'postgres',
          }) as unknown as Probe
        ).compareTableChecks(TABLE, definition),
    };
  }

  it('adds the constraint when the table does not have it', async () => {
    const changes = await comparer({ live: [] }).run();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'alter_column',
      name: 'title',
      alteration: 'set_check',
    });
    expect(changes[0].sqlStatements?.[0]).toBe(
      `ALTER TABLE "${TABLE}" ADD CONSTRAINT "${declared.name}" CHECK (${declared.expression})`,
    );
  });

  it('does nothing when the constraint is already there', async () => {
    expect(await comparer({ live: [declared.name] }).run()).toEqual([]);
  });

  it('reports instead of failing when live rows already break the rule', async () => {
    const [change] = await comparer({ live: [], violating: true }).run();
    expect(change.sqlStatements).toBeUndefined();
    expect(change.advisory?.message).toContain(`${TABLE}.title`);
  });

  it('drops a smrt_ck_ constraint the manifest no longer declares, and only that', async () => {
    const changes = await comparer({
      live: [declared.name, 'smrt_ck_stale'],
    }).run();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      alteration: 'drop_check',
      name: 'smrt_ck_stale',
    });
    expect(changes[0].sqlStatements).toEqual([
      `ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "smrt_ck_stale"`,
    ]);
  });

  it('reads only smrt_ck_ names from the catalog', async () => {
    const c = comparer({ live: [] });
    await c.run();
    expect(c.queries.find((q) => q.includes('pg_constraint'))).toContain(
      `LIKE 'smrt\\_ck\\_%'`,
    );
  });

  it('is silent on SQLite', async () => {
    const db = { url: 'sqlite://x', query: async () => ({ rows: [] }) };
    const changes = await (
      new SchemaComparer(db as unknown as DatabaseInterface, {
        engineHint: 'sqlite',
      }) as unknown as Probe
    ).compareTableChecks(TABLE, definition);
    expect(changes).toEqual([]);
  });
});
