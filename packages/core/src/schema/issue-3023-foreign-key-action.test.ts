/**
 * #3023: a `@foreignKey(..., { onDelete })` whose column is also a
 * `conflictColumns` entry must keep its declared action end to end.
 *
 * Two halves are covered here:
 *  1. The manifest generator honours a declared `onDelete` (the scanner now
 *     carries it in `_meta`) and only falls back to the natural-key CASCADE
 *     default when none is declared.
 *  2. On PostgreSQL the differ converges a framework-owned constraint whose
 *     only drift is its action (drop + add + validate in the migration), and
 *     keeps the manual advisory for anything it cannot prove it owns.
 */
import { describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectDefinition } from '../scanner/types.js';
import { foreignKeyConstraintName } from './foreign-key-ddl.js';
import type { ForeignKeyAction, SchemaDefinition } from './types.js';

function objectDef(
  className: string,
  tableName: string,
  fields: SmartObjectDefinition['fields'],
  decoratorConfig: SmartObjectDefinition['decoratorConfig'] = {},
): SmartObjectDefinition {
  return {
    name: className.charAt(0).toLowerCase() + className.slice(1),
    className,
    collection: tableName,
    filePath: `/fixture/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: { tableName, ...decoratorConfig },
    exportName: className,
    collectionExportName: `${className}Collection`,
  };
}

function councilMemberManifest(onDelete?: ForeignKeyAction) {
  const generator = new ManifestGenerator();
  return generator.generateManifest([
    {
      filePath: '/fixture/council.ts',
      objects: [
        objectDef('Council3023', 'councils_3023', {
          name: { type: 'text' },
        }),
        objectDef(
          'CouncilMember3023',
          'council_members_3023',
          {
            councilId: {
              type: 'foreignKey',
              related: 'Council3023',
              required: true,
              ...(onDelete ? { _meta: { required: true, onDelete } } : {}),
            },
            personName: { type: 'text' },
          },
          { conflictColumns: ['councilId', 'personName'] },
        ),
      ],
      imports: [],
      exports: [],
    },
  ]);
}

describe('declared onDelete on a conflictColumns foreign key (#3023)', () => {
  it('defaults a natural-key reference to CASCADE when no action is declared', () => {
    const manifest = councilMemberManifest();
    expect(
      manifest.objects.councilMember3023.schema?.columns.council_id?.foreignKey
        ?.onDelete,
    ).toBe('CASCADE');
  });

  it.each([
    'NO ACTION',
    'RESTRICT',
    'SET NULL',
    'CASCADE',
  ] as const)('keeps a declared %s instead of forcing CASCADE', (action) => {
    const manifest = councilMemberManifest(action);
    expect(
      manifest.objects.councilMember3023.schema?.columns.council_id?.foreignKey,
    ).toEqual(
      expect.objectContaining({
        table: 'councils_3023',
        column: 'id',
        onDelete: action,
      }),
    );
  });
});

function schema(onDelete: ForeignKeyAction): SchemaDefinition {
  return {
    tableName: 'children',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      parent_id: {
        type: 'TEXT',
        foreignKey: {
          table: 'parents',
          column: 'id',
          onDelete,
          onUpdate: 'CASCADE',
        },
      },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [
      {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
        onDelete,
        onUpdate: 'CASCADE',
      },
    ],
    dependencies: ['parents'],
    version: '3023',
  };
}

const canonicalName = foreignKeyConstraintName('children', {
  column: 'parent_id',
  referencesTable: 'parents',
  referencesColumn: 'id',
});

function postgresMock(catalogRows: Array<Record<string, unknown>>) {
  const queries: string[] = [];
  return {
    queries,
    db: {
      url: 'postgres://fixture/issue3023',
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'children' }] };
        }
        if (sql.includes('FROM pg_constraint')) {
          return { rows: catalogRows };
        }
        return { rows: [] };
      },
      getTableSchema: async () => ({
        columns: {
          id: { name: 'id', type: 'text', primaryKey: true },
          parent_id: { name: 'parent_id', type: 'text' },
        },
        indexes: [],
        foreignKeys: [
          {
            column: 'parent_id',
            referencesTable: 'parents',
            referencesColumn: 'id',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
        ],
      }),
    },
  };
}

function ownedRow(overrides: Record<string, unknown> = {}) {
  return {
    constraint_name: canonicalName,
    validated: true,
    deferrable: false,
    match_type: 's',
    child_keys: 1,
    parent_keys: 1,
    child_column: 'parent_id',
    parent_table: 'parents',
    parent_column: 'id',
    nondefault_trigger_mode: false,
    ...overrides,
  };
}

async function diffFor(catalogRows: Array<Record<string, unknown>>) {
  const mock = postgresMock(catalogRows);
  const diff = await new SchemaComparer(mock.db as never, {
    engineHint: 'postgres',
  }).compare({ children: schema('NO ACTION') });
  const change = diff.changes.find(
    (candidate) => candidate.type === 'add_foreign_key',
  );
  return { mock, diff, change };
}

describe('PostgreSQL ON DELETE convergence (#3023)', () => {
  it('replaces a framework-owned constraint whose only drift is its action', async () => {
    const { change, mock } = await diffFor([ownedRow()]);

    // Toward a less destructive action: no warning.
    expect(change?.advisory).toBeUndefined();
    // Build-then-swap: the staged constraint is validated before the old
    // one is dropped, so no ACCESS EXCLUSIVE lock is held during the scan.
    expect(change?.sqlStatements).toEqual([
      `ALTER TABLE "children" ADD CONSTRAINT "${canonicalName}_smrt_new" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID`,
      `ALTER TABLE "children" VALIDATE CONSTRAINT "${canonicalName}_smrt_new"`,
      `ALTER TABLE "children" DROP CONSTRAINT "${canonicalName}"`,
      `ALTER TABLE "children" RENAME CONSTRAINT "${canonicalName}_smrt_new" TO "${canonicalName}"`,
    ]);
    expect(change?.note).toBe(
      `replaces ${canonicalName}: ON DELETE CASCADE → NO ACTION`,
    );
    // The same orphan probe as a fresh constraint still runs first.
    expect(mock.queries.some((sql) => sql.includes('orphan_key'))).toBe(true);
  });

  it('warns loudly when the replacement turns on CASCADE', async () => {
    const mock = postgresMock([ownedRow()]);
    const live = await mock.db.getTableSchema();
    live.foreignKeys[0].onDelete = 'NO ACTION';
    mock.db.getTableSchema = async () => live;
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: schema('CASCADE') });
    const change = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );
    expect(change?.sqlStatements?.length).toBe(4);
    expect(change?.advisory?.severity).toBe('warning');
    expect(change?.advisory?.message).toMatch(/DESTRUCTIVE/);
    expect(change?.advisory?.message).toMatch(
      /deleting a parents row will now DELETE its children rows \(was NO ACTION\)/,
    );
  });

  it.each([
    ['a differently named constraint', { constraint_name: 'legacy_fk' }],
    ['an unvalidated constraint', { validated: false }],
    ['a deferrable constraint', { deferrable: true }],
    ['a MATCH FULL constraint', { match_type: 'f' }],
    ['a multi-column constraint', { child_keys: 2, parent_keys: 2 }],
    ['disabled enforcement triggers', { nondefault_trigger_mode: true }],
  ])('keeps the manual advisory for %s', async (_label, overrides) => {
    const { change } = await diffFor([ownedRow(overrides)]);

    expect(change?.sqlStatements).toBeUndefined();
    expect(change?.advisory?.message).toMatch(
      /exists with a different target or action/,
    );
  });

  it('keeps the manual advisory when the catalog has no single matching row', async () => {
    expect((await diffFor([])).change?.advisory).toBeDefined();
    expect(
      (await diffFor([ownedRow(), ownedRow({ constraint_name: 'dup' })])).change
        ?.advisory,
    ).toBeDefined();
  });

  it('refuses the replacement when orphan rows exist', async () => {
    const mock = postgresMock([ownedRow()]);
    const query = mock.db.query;
    mock.db.query = async (sql: string) =>
      sql.includes('orphan_key')
        ? ({ rows: [{ orphan_key: 'missing' }] } as never)
        : query(sql);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: schema('NO ACTION') });
    const change = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );

    expect(change?.orphanBlocked).toBe(true);
    expect(change?.sqlStatements).toBeUndefined();
  });

  it('reports nothing once the live action matches the manifest', async () => {
    const mock = postgresMock([ownedRow()]);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: schema('CASCADE') });

    expect(
      diff.changes.some((change) => change.type === 'add_foreign_key'),
    ).toBe(false);
    expect(mock.queries.some((sql) => sql.includes('FROM pg_constraint'))).toBe(
      false,
    );
  });
});
