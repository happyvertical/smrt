/**
 * #3299: validation and engine shape of STI subclass-declared indexes on the
 * manifest (production) path. The happy path and cross-path parity live in
 * `schema-path-parity.test.ts`; real-database behavior in
 * `__tests__/issue-3299-sti-subclass-indexes*.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { getDDLStrategy } from './ddl/index.js';
import { manifestSchemaToDefinition } from './manifest-schema.js';

const PKG = '@fixture/issue-3299';

function def(
  className: string,
  decoratorConfig: Record<string, unknown>,
  extendsName?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `packages/fixture/src/${className}.ts`,
    packageName: PKG,
    packageVersion: '0.0.0',
    fields: { code: { type: 'text' }, ref: { type: 'text' } },
    methods: {},
    decoratorConfig:
      decoratorConfig as SmartObjectDefinition['decoratorConfig'],
    extends: extendsName,
  } as SmartObjectDefinition;
}

function generate(children: Array<Record<string, unknown>>) {
  const objects: Record<string, SmartObjectDefinition> = {
    [`${PKG}:Base3299`]: def('Base3299', {
      tableStrategy: 'sti',
      tableName: 'v3299_items',
    }),
  };
  children.forEach((config, i) => {
    const name = `Child${i}3299`;
    objects[`${PKG}:${name}`] = def(name, config, 'Base3299');
  });
  const manifest: SmartObjectManifest = {
    version: '1.0.0',
    timestamp: 0,
    packageName: PKG,
    packageVersion: '0.0.0',
    objects,
  };
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: PKG,
  });
  return manifest.objects[`${PKG}:Base3299`].schema;
}

describe('#3299 STI subclass-declared index validation', () => {
  it('refuses a subclass unique index that carries its own where', () => {
    expect(() =>
      generate([
        {
          indexes: [
            {
              name: 'v3299_items_code_active_uidx',
              columns: ['code'],
              unique: true,
              where: 'ref IS NOT NULL',
            },
          ],
        },
      ]),
    ).toThrow(/cannot carry its own "where"/);
  });

  it('keeps a plain subclass index with its own where unqualified by subtype', () => {
    const schema = generate([
      {
        indexes: [
          {
            name: 'v3299_items_ref_present_idx',
            columns: ['ref'],
            where: 'ref IS NOT NULL',
          },
        ],
      },
    ]);
    expect(
      schema?.indexes?.find((i) => i.name === 'v3299_items_ref_present_idx'),
    ).toMatchObject({ columns: ['ref'], where: 'ref IS NOT NULL' });
  });

  it('refuses an unknown column, a non-array config, and an over-long name', () => {
    expect(() =>
      generate([
        { indexes: [{ name: 'v3299_items_missing_idx', columns: ['nope'] }] },
      ]),
    ).toThrow(/unknown column/);
    expect(() => generate([{ indexes: { name: 'x' } }])).toThrow(
      /must be an array/,
    );
    expect(() =>
      generate([
        {
          indexes: [{ name: `v3299_${'x'.repeat(70)}`, columns: ['code'] }],
        },
      ]),
    ).toThrow();
  });

  it('refuses two siblings declaring one unique index name for different subtypes', () => {
    const index = {
      name: 'v3299_items_code_uidx',
      columns: ['code'],
      unique: true,
    };
    expect(() =>
      generate([{ indexes: [index] }, { indexes: [index] }]),
    ).toThrow(/collides with a different index/);
  });

  it('emits the subtype-scoped unique on PostgreSQL/SQLite and never widens it on DuckDB', () => {
    const schema = generate([
      {
        indexes: [
          { name: 'v3299_items_code_uidx', columns: ['code'], unique: true },
        ],
      },
    ]);
    const definition = manifestSchemaToDefinition(
      schema as NonNullable<typeof schema>,
    );
    const where = `_meta_type = '${PKG}:Child03299'`;
    for (const engine of ['postgres', 'sqlite'] as const) {
      const sql = getDDLStrategy(engine)
        .generateIndexes(definition)
        .find((statement) => statement.includes('v3299_items_code_uidx'));
      expect(sql).toMatch(/CREATE UNIQUE INDEX/);
      expect(sql).toContain(where);
    }
    expect(
      getDDLStrategy('duckdb')
        .generateIndexes(definition)
        .some((statement) => statement.includes('v3299_items_code_uidx')),
    ).toBe(false);
  });
});
