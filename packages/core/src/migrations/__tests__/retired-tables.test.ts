/**
 * Declared table retirements (#5005): the declaration's checks, how a package
 * carries it into its manifest and the registry, and how the build's stamp
 * covers it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  describeManifestSchema,
  registerBuildSchema,
  resolveRetiredTables,
} from '../build-schema.js';
import {
  mergeRetiredTables,
  RetiredTableDeclarationError,
  readRetiredTablesFromPackageJson,
  registerRetiredTables,
  retiredTablesStampInput,
} from '../retired-tables.js';
import { computeSchemaFingerprint } from '../schema-fingerprint.js';

const PKG = '@acme/orders';
const entry = (extra: Record<string, unknown> = {}) => ({
  table: 'acme_order_drafts',
  lastOwner: `${PKG}:OrderDraft`,
  since: '1.4.0',
  reason: 'Drafts are kept on the order itself.',
  rows: 'discard' as const,
  definitions: [
    {
      release: '1.3.2',
      columns: { id: { type: 'UUID' as const, referenceKind: 'id' as const } },
    },
  ],
  ...extra,
});
const packageJson = (...list: unknown[]) => ({
  name: PKG,
  smrt: { retiredTables: list },
});

describe('the retired-table declaration (#5005)', () => {
  it('reads smrt.retiredTables from package.json, carrying the package', () => {
    expect(readRetiredTablesFromPackageJson(packageJson(entry()), PKG)).toEqual(
      [{ ...entry(), packageName: PKG }],
    );
    expect(readRetiredTablesFromPackageJson({ name: PKG }, PKG)).toEqual([]);
  });

  it('keeps rows optional: absent means rows must not be discarded', () => {
    const [parsed] = readRetiredTablesFromPackageJson(
      packageJson(entry({ rows: undefined })),
      PKG,
    );
    expect(parsed).not.toHaveProperty('rows');
  });

  it.each([
    ['a missing reason', { reason: ' ' }, /"reason" must say why/],
    ['an unknown key', { note: 'x' }, /unknown key\(s\) note/],
    ['rows other than discard', { rows: 'keep' }, /'discard'/],
    ['a bad release', { since: 'soon' }, /"since" must be the release/],
    ['a bad table name', { table: 'a b;' }, /plain table name/],
    ['an unqualified owner', { lastOwner: 'OrderDraft' }, /"lastOwner"/],
    [
      'an owner in another package',
      { lastOwner: '@other/pkg:OrderDraft' },
      /belongs to another package/,
    ],
    ['a smrt system table', { table: '_smrt_migrate_runs' }, /system table/],
    // SQLite and DuckDB compare table names without case (R4).
    [
      'a mixed-case table name',
      { table: 'Acme_Order_Drafts' },
      /plain table name/,
    ],
    [
      'a _smrt_ table from a package outside smrt',
      { table: '_smrt_order_drafts' },
      /only smrt's own packages/,
    ],
    [
      'no definitions',
      { definitions: undefined },
      /retired-table-facts\.mjs definition/,
    ],
    ['an empty list of definitions', { definitions: [] }, /"definitions"/],
    [
      'the old single definition',
      { definition: { release: '1.3.2', columns: { id: { type: 'UUID' } } } },
      /unknown key\(s\) definition/,
    ],
    [
      'a definition without columns',
      { definitions: [{ release: '1.3.2', columns: {} }] },
      /definition of release 1\.3\.2 must list/,
    ],
    [
      'a definition with an unknown type',
      {
        definitions: [
          { release: '1.3.2', columns: { id: { type: 'VARCHAR' } } },
        ],
      },
      /column id of the definition of release 1\.3\.2/,
    ],
    [
      'a definition with an extra key',
      {
        definitions: [
          {
            release: '1.3.2',
            columns: { id: { type: 'UUID' } },
            hash: 'abc',
          },
        ],
      },
      /unknown key\(s\) hash/,
    ],
    [
      'two definitions of one release',
      {
        definitions: [
          { release: '1.3.2', columns: { id: { type: 'UUID' } } },
          { release: '1.3.2', columns: { id: { type: 'TEXT' } } },
        ],
      },
      /lists release 1\.3\.2 twice/,
    ],
  ])('refuses %s, naming the table', (_name, bad, message) => {
    const attempt = () =>
      readRetiredTablesFromPackageJson(packageJson(entry(bad)), PKG, (table) =>
        table.startsWith('_smrt_migrate'),
      );
    expect(attempt).toThrow(message);
    expect(attempt).toThrow(RetiredTableDeclarationError);
  });

  it("lets smrt's own packages retire a _smrt_ table", () => {
    const name = '@happyvertical/smrt-inference';
    expect(
      readRetiredTablesFromPackageJson(
        {
          name,
          smrt: {
            retiredTables: [
              entry({ table: '_smrt_old_runs', lastOwner: `${name}:OldRun` }),
            ],
          },
        },
        name,
      )[0].table,
    ).toBe('_smrt_old_runs');
  });

  it('refuses a table declared twice in one package', () => {
    expect(() =>
      readRetiredTablesFromPackageJson(packageJson(entry(), entry()), PKG),
    ).toThrow(/declared twice/);
  });

  it('merges lists to one entry per table and package, in stable order', () => {
    const a = { ...entry({ table: 'b_table' }), packageName: PKG };
    const b = { ...entry({ table: 'a_table' }), packageName: PKG };
    expect(mergeRetiredTables([a, b], [a]).map((item) => item.table)).toEqual([
      'a_table',
      'b_table',
    ]);
  });
});

describe('the build stamp covers the retired list (#5005)', () => {
  const tables = [
    {
      tableName: 't',
      columns: { id: { type: 'UUID' as const, primaryKey: true } },
      indexes: [],
      foreignKeys: [],
      triggers: [],
      dependencies: [],
      version: '',
    },
  ];
  const retired = (rows?: 'discard') => [
    { ...entry({ rows }), packageName: PKG },
  ];

  it('is unchanged when nothing is retired, so existing builds keep their stamp', () => {
    expect(computeSchemaFingerprint(tables)).toBe(
      computeSchemaFingerprint(tables, { retired: [] }),
    );
  });

  it('changes when a table is retired, or whether its rows may go', () => {
    const none = computeSchemaFingerprint(tables);
    const discard = computeSchemaFingerprint(tables, {
      retired: retired('discard'),
    });
    const keep = computeSchemaFingerprint(tables, { retired: retired() });
    expect(new Set([none, discard, keep]).size).toBe(3);
  });

  it('ignores prose and order: reason, release and owner', () => {
    const base = computeSchemaFingerprint(tables, {
      retired: retired('discard'),
    });
    expect(
      computeSchemaFingerprint(tables, {
        retired: [
          {
            ...retired('discard')[0],
            reason: 'reworded',
            since: '2.0.0',
            lastOwner: `${PKG}:Other`,
          },
        ],
      }),
    ).toBe(base);
    expect(
      retiredTablesStampInput([
        { ...entry({ table: 'z' }) } as never,
        { ...entry({ table: 'a' }) } as never,
      ]).map((item) => item.table),
    ).toEqual(['a', 'z']);
  });

  it("covers every release's definition: the columns, not the release they came from", () => {
    const older = {
      release: '1.2.0',
      columns: { id: { type: 'TEXT' as const } },
    };
    const both = [
      {
        ...entry({ definitions: [older, ...entry().definitions] }),
        packageName: PKG,
      },
    ];
    const stamped = computeSchemaFingerprint(tables, { retired: both });
    // Another shape a database may hold changes what migrate drops.
    expect(stamped).not.toBe(
      computeSchemaFingerprint(tables, { retired: retired('discard') }),
    );
    expect(retiredTablesStampInput(both)[0].definitions).toHaveLength(2);
    // The release a definition was read from is provenance.
    expect(
      computeSchemaFingerprint(tables, {
        retired: [
          {
            ...both[0],
            definitions: both[0].definitions.map((definition) => ({
              ...definition,
              release: `${definition.release}-rc.1`,
            })),
          },
        ],
      }),
    ).toBe(stamped);
  });
});

describe('a package carries its retirement into manifest, build and registry (#5005)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => {
    registerBuildSchema(undefined);
    restore();
  });

  const manifestFor = (json: unknown) =>
    JSON.parse(
      JSON.stringify(
        new ManifestGenerator().generateManifest(
          [{ filePath: `/${PKG}`, errors: [], objects: [] }],
          { packageName: PKG, packageJson: json as never },
        ),
      ),
    );

  it('writes retiredTables into the manifest and moves its stamp', () => {
    const plain = manifestFor({ name: PKG });
    const retiring = manifestFor(packageJson(entry()));
    expect(plain.retiredTables).toBeUndefined();
    expect(retiring.retiredTables).toEqual([{ ...entry(), packageName: PKG }]);
    expect(retiring.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(retiring.schemaFingerprint).not.toBe(plain.schemaFingerprint);
  });

  it('fails the build on a malformed declaration', () => {
    expect(() => manifestFor(packageJson(entry({ reason: '' })))).toThrow(
      /reason/,
    );
  });

  it('registers with the package manifest, wherever the package is installed', () => {
    const manifest = manifestFor(packageJson(entry()));
    expect(ObjectRegistry.getRetiredTables()).toEqual([]);
    ObjectRegistry.registerPackageManifest(manifest);
    expect(ObjectRegistry.getRetiredTables()).toEqual([
      { ...entry(), packageName: PKG },
    ]);
    ObjectRegistry.clear();
    expect(ObjectRegistry.getRetiredTables()).toEqual([]);
  });

  it('keeps each entry its own package: one labelled with another is refused, never relabelled (R11)', () => {
    const own = { ...entry(), packageName: PKG };
    expect(() => registerRetiredTables('@acme/app', [own])).toThrow(
      /labelled @acme\/orders, but @acme\/app registered it/,
    );
    expect(() =>
      ObjectRegistry.registerPackageManifest({
        ...manifestFor(packageJson(entry())),
        retiredTables: [
          {
            ...entry({ lastOwner: '@other/pkg:OrderDraft' }),
            packageName: '@other/pkg',
          },
        ],
      }),
    ).toThrow(/carries only its own retirements/);
    expect(ObjectRegistry.getRetiredTables()).toEqual([]);
  });

  it('checks a loaded manifest file: forged owners fail, stale entries of an app manifest drop out', () => {
    const forgedOwner = {
      ...entry({ lastOwner: '@other/pkg:OrderDraft' }),
      packageName: PKG,
    };
    expect(() =>
      ObjectRegistry.registerManifestRetiredTables({
        packageName: PKG,
        retiredTables: [forgedOwner],
      }),
    ).toThrow(/belongs to another package/);
    expect(() =>
      ObjectRegistry.registerManifestRetiredTables({
        packageName: PKG,
        retiredTables: [
          {
            ...entry({ lastOwner: '@other/pkg:OrderDraft' }),
            packageName: '@other/pkg',
          },
        ],
      }),
    ).toThrow(/carries only its own retirements/);

    // An app's merged manifest: its dependencies' entries, not a stale one.
    ObjectRegistry.registerManifestRetiredTables(
      {
        packageName: '@acme/app',
        retiredTables: [
          { ...entry(), packageName: PKG },
          {
            ...entry({ table: 'gone_table', lastOwner: '@gone/pkg:Old' }),
            packageName: '@gone/pkg',
          },
        ],
      },
      { consumed: [PKG] },
    );
    expect(
      ObjectRegistry.getRetiredTables().map((item) => item.packageName),
    ).toEqual([PKG]);
    // A package's manifest with no entries clears its list.
    ObjectRegistry.registerManifestRetiredTables({ packageName: PKG });
    expect(ObjectRegistry.getRetiredTables()).toEqual([]);
  });

  it("registers an app manifest's carried dependency entries under their own package; plan and stamp agree", () => {
    // A package built as an app (app-shell): its dist/manifest.json carries
    // the retirements of the packages it depends on.
    const app = {
      packageName: '@acme/app',
      version: '1.0.0',
      timestamp: 0,
      smrtDependencies: [PKG],
      objects: {},
      retiredTables: [{ ...entry(), packageName: PKG }],
    };
    expect(ObjectRegistry.registerPackageManifest(app).loaded).toBe(true);
    expect(ObjectRegistry.getRetiredTables()).toEqual([
      { ...entry(), packageName: PKG },
    ]);
    // The plan without a build reads the registry; with one, the build's
    // description; the stamp covers the description's set. All one set.
    expect(resolveRetiredTables()).toEqual(describeManifestSchema(app).retired);
    registerBuildSchema(describeManifestSchema(app));
    expect(resolveRetiredTables()).toEqual(ObjectRegistry.getRetiredTables());
    expect(describeManifestSchema(app).fingerprint).toBe(
      computeSchemaFingerprint([], {
        retired: ObjectRegistry.getRetiredTables(),
      }),
    );
  });

  it('refuses a carried entry of a package outside the manifest dependencies, registering nothing', () => {
    const forged = {
      ...entry({ table: 'other_table', lastOwner: '@other/pkg:Old' }),
      packageName: '@other/pkg',
    };
    expect(() =>
      ObjectRegistry.registerPackageManifest({
        packageName: '@acme/app',
        version: '1.0.0',
        timestamp: 0,
        smrtDependencies: [PKG],
        objects: {},
        retiredTables: [{ ...entry(), packageName: PKG }, forged],
      }),
    ).toThrow(
      /labelled @other\/pkg, not @acme\/app or a package it depends on/,
    );
    // Still fully checked: a dependency's entry naming another owner fails.
    expect(() =>
      ObjectRegistry.registerPackageManifest({
        packageName: '@acme/app',
        version: '1.0.0',
        timestamp: 0,
        smrtDependencies: [PKG],
        objects: {},
        retiredTables: [
          {
            ...entry({ lastOwner: '@other/pkg:OrderDraft' }),
            packageName: PKG,
          },
        ],
      }),
    ).toThrow(/belongs to another package/);
    expect(ObjectRegistry.getRetiredTables()).toEqual([]);
  });

  it.each([
    ['own first', true],
    ['app first', false],
  ])('collapses an entry arriving through several manifests (%s), and a carried copy never shrinks the own list', (_name, ownFirst) => {
    const second = entry({
      table: 'acme_order_notes',
      lastOwner: `${PKG}:OrderNote`,
    });
    const own = manifestFor(packageJson(entry(), second));
    const carrying = (name: string) => ({
      packageName: name,
      version: '1.0.0',
      timestamp: 0,
      smrtDependencies: [PKG],
      objects: {},
      retiredTables: [{ ...entry(), packageName: PKG }],
    });
    const order = ownFirst
      ? [own, carrying('@acme/app'), carrying('@acme/shell')]
      : [carrying('@acme/app'), carrying('@acme/shell'), own];
    for (const manifest of order)
      ObjectRegistry.registerPackageManifest(manifest);
    expect(
      ObjectRegistry.getRetiredTables().map((item) => [
        item.packageName,
        item.table,
      ]),
    ).toEqual([
      [PKG, 'acme_order_drafts'],
      [PKG, 'acme_order_notes'],
    ]);
  });

  it('describes the build with only the packages it depends on, and stamps the same set', () => {
    const app = {
      packageName: '@acme/app',
      smrtDependencies: [PKG],
      objects: {},
      retiredTables: [
        { ...entry(), packageName: PKG },
        {
          ...entry({ table: 'gone_table', lastOwner: '@gone/pkg:Old' }),
          packageName: '@gone/pkg',
        },
      ],
    };
    const build = describeManifestSchema(app);
    expect(build.retired?.map((item) => item.table)).toEqual([
      'acme_order_drafts',
    ]);
    expect(build.fingerprint).toBe(
      describeManifestSchema({ ...app, retiredTables: [app.retiredTables[0]] })
        .fingerprint,
    );
  });

  it("is part of the build's description, and resolves with the registry's", () => {
    const manifest = manifestFor(packageJson(entry()));
    const build = describeManifestSchema(manifest);
    expect(build.retired).toEqual([{ ...entry(), packageName: PKG }]);
    expect(build.fingerprint).toBe(manifest.schemaFingerprint);
    registerBuildSchema(build);
    expect(resolveRetiredTables().map((item) => item.table)).toEqual([
      'acme_order_drafts',
    ]);
    // A description written before the field existed declares none.
    const { retired: _omit, ...old } = build;
    registerBuildSchema(old);
    expect(resolveRetiredTables()).toEqual([]);
  });
});
