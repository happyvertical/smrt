/**
 * Issue #2372: the merged STI table shape depended on class registration order.
 *
 * `getAllSchemas()` / `getAllSchemasAsDefinitions()` merged first-wins: the
 * class that happened to register first for a table seeded the base columns,
 * the id type, the conflict columns and the cached DDL, and won every column
 * conflict. An STI child that carries no manifest `schema` (the external- and
 * consumer-manifest case) therefore seeded the table from bare fallback base
 * columns — `context TEXT` instead of `context TEXT NOT NULL DEFAULT ''`,
 * timestamps without NOT NULL/DEFAULT — and the base class's richer columns
 * were skipped when it registered later. The differ compares types only, so a
 * weak fresh-create was never repaired.
 *
 * In the shipped content manifest `Article` precedes `Content`, so the order
 * that loses is the one that actually ships.
 *
 * These regressions register the same hierarchy in several orders and assert
 * one identical merged schema.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

/**
 * Base-class manifest entry, shaped like real `generateSTISchemaFromManifest`
 * output: system columns carry NOT NULL/DEFAULT, every field column is
 * nullable (the table is the union of all subtypes' fields).
 */
const BASE_MANIFEST = {
  className: 'Issue2372Content',
  fields: {
    title: { type: 'text', required: true, default: '' },
    body: { type: 'text', required: false, default: '' },
  },
  methods: {},
  decoratorConfig: { tableStrategy: 'sti' },
  schema: {
    tableName: 'issue2372_contents',
    ddl: '',
    columns: {
      id: {
        type: 'UUID',
        primaryKey: true,
        notNull: true,
        referenceKind: 'id',
      },
      slug: { type: 'TEXT', notNull: true },
      context: { type: 'TEXT', notNull: true, defaultValue: '' },
      created_at: {
        type: 'TIMESTAMP',
        notNull: true,
        defaultValue: 'current_timestamp',
      },
      updated_at: {
        type: 'TIMESTAMP',
        notNull: true,
        defaultValue: 'current_timestamp',
      },
      _meta_type: { type: 'TEXT', notNull: true },
      _meta_data: { type: 'JSON', notNull: false },
      title: { type: 'TEXT', notNull: false, defaultValue: '' },
      body: { type: 'TEXT', notNull: false, defaultValue: '' },
    },
    indexes: [
      {
        name: 'issue2372_contents_meta_type_idx',
        columns: ['_meta_type'],
      },
    ],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
  },
};

/**
 * Same-package STI children with no manifest `schema` block. Their columns can
 * only come from runtime field metadata, which keeps `required`/`default`
 * under `_meta`.
 */
const ARTICLE_MANIFEST = {
  className: 'Issue2372Article',
  extends: 'Issue2372Content',
  fields: {
    title: { type: 'text', required: true, default: '' },
    body: { type: 'text', required: false, default: '' },
    byline: { type: 'text', required: true, default: 'staff' },
  },
  methods: {},
  decoratorConfig: { tableStrategy: 'sti' },
};

const MIRROR_MANIFEST = {
  className: 'Issue2372Mirror',
  extends: 'Issue2372Content',
  fields: {
    title: { type: 'text', required: true, default: '' },
    sourceUrl: { type: 'text', required: true, default: '' },
  },
  methods: {},
  decoratorConfig: { tableStrategy: 'sti' },
};

type ManifestEntry =
  | typeof BASE_MANIFEST
  | typeof ARTICLE_MANIFEST
  | typeof MIRROR_MANIFEST;

const PACKAGE_NAME = '@test/issue-2372';

function register(entry: ManifestEntry) {
  ObjectRegistry.registerFromManifest(
    entry.className,
    entry as never,
    PACKAGE_NAME,
  );
}

/**
 * Register the hierarchy in the given order and return the merged table.
 */
function schemaForOrder(order: ManifestEntry[]) {
  const restore = snapshotObjectRegistryState();
  try {
    for (const entry of order) {
      register(entry);
    }
    return {
      definition:
        ObjectRegistry.getAllSchemasAsDefinitions().issue2372_contents,
      bootstrap: ObjectRegistry.getAllSchemas().issue2372_contents,
    };
  } finally {
    restore();
  }
}

describe('Issue #2372: merged STI table shape is registration-order independent', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('produces an identical schema whether the base or the child registers first', () => {
    const baseFirst = schemaForOrder([BASE_MANIFEST, ARTICLE_MANIFEST]);
    const childFirst = schemaForOrder([ARTICLE_MANIFEST, BASE_MANIFEST]);

    expect(baseFirst.definition).toBeDefined();
    expect(childFirst.definition).toEqual(baseFirst.definition);

    // Column order drives the generated DDL, so it has to match too.
    expect(Object.keys(childFirst.definition?.columns ?? {})).toEqual(
      Object.keys(baseFirst.definition?.columns ?? {}),
    );
    expect(childFirst.definition?.ddl).toBe(baseFirst.definition?.ddl);
  });

  it('keeps the same shape across every permutation of a multi-child hierarchy', () => {
    const permutations: ManifestEntry[][] = [
      [BASE_MANIFEST, ARTICLE_MANIFEST, MIRROR_MANIFEST],
      [ARTICLE_MANIFEST, BASE_MANIFEST, MIRROR_MANIFEST],
      [ARTICLE_MANIFEST, MIRROR_MANIFEST, BASE_MANIFEST],
      [MIRROR_MANIFEST, ARTICLE_MANIFEST, BASE_MANIFEST],
    ];

    const [expected, ...rest] = permutations.map(schemaForOrder);
    expect(expected.definition?.columns.byline).toBeDefined();
    expect(expected.definition?.columns.source_url).toBeDefined();

    for (const actual of rest) {
      expect(actual.definition).toEqual(expected.definition);
      expect(actual.bootstrap).toEqual(expected.bootstrap);
    }
  });

  it('keeps NOT NULL and DEFAULT on the base columns when a child registers first', () => {
    const { definition } = schemaForOrder([ARTICLE_MANIFEST, BASE_MANIFEST]);
    const columns = definition?.columns ?? {};

    expect(columns.context).toMatchObject({
      type: 'TEXT',
      notNull: true,
      defaultValue: '',
    });
    expect(columns.created_at).toMatchObject({
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
    });
    expect(columns.updated_at).toMatchObject({
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
    });
    expect(columns.slug).toMatchObject({ type: 'TEXT', notNull: true });
    expect(columns.id).toMatchObject({ primaryKey: true, notNull: true });
    expect(columns._meta_type).toMatchObject({ type: 'TEXT', notNull: true });

    expect(definition?.ddl).toContain(`"context" TEXT NOT NULL DEFAULT ''`);
    expect(definition?.ddl).toContain(
      '"created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp',
    );
  });

  it('carries a child field default onto the shared table while keeping the column nullable', () => {
    const { definition } = schemaForOrder([BASE_MANIFEST, ARTICLE_MANIFEST]);
    const byline = definition?.columns.byline;

    // The default lives under `_meta` on a registry field; reading only the
    // top level dropped it.
    expect(byline?.defaultValue).toBe('staff');
    // An STI table holds the union of all subtypes' fields, so a column only
    // one subtype declares must stay nullable even though the field is
    // `required` on that subtype.
    expect(byline?.notNull).toBe(false);
  });

  it('seeds conflict columns and indexes from the STI base regardless of order', () => {
    const baseFirst = schemaForOrder([BASE_MANIFEST, ARTICLE_MANIFEST]);
    const childFirst = schemaForOrder([ARTICLE_MANIFEST, BASE_MANIFEST]);

    const names = (schema: typeof baseFirst) =>
      (schema.definition?.indexes ?? []).map((index) => index.name).sort();

    expect(names(childFirst)).toEqual(names(baseFirst));
    expect(names(baseFirst)).toContain('issue2372_contents_meta_type_idx');
  });
});
