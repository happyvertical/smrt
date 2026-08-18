/**
 * #2358 — `schema.ddl` is a CREATE TABLE preview, not the table.
 *
 * Every consumer of raw manifest JSON must render tables and indexes from
 * the structured `columns` / `indexes` through the engine DDL strategy —
 * the same renderer `db:migrate` uses — and only fall back to the cached
 * `ddl` string when a manifest object exposes no structured columns.
 *
 * Also covers the SQLite primary-key NOT NULL fix that ships with #2358:
 * a bare `"id" TEXT PRIMARY KEY` accepts NULL on SQLite.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { getDDLStrategy } from './ddl/index.js';
import {
  collectManifestTables,
  manifestSchemaToDefinition,
  mergeSchemaDefinitionInto,
  renderCollectedManifestTable,
} from './manifest-schema.js';
import type { SchemaDefinition } from './types.js';

const CACHED_PREVIEW =
  'CREATE TABLE IF NOT EXISTS "events" ("id" TEXT PRIMARY KEY NOT NULL, "slug" TEXT NOT NULL, "payload" JSON);';

const structuredEvent = {
  tableName: 'events',
  ddl: CACHED_PREVIEW,
  columns: {
    id: { type: 'UUID', primaryKey: true, notNull: true, referenceKind: 'id' },
    slug: { type: 'TEXT', notNull: true },
    context: { type: 'TEXT', notNull: true, default: '' },
    payload: { type: 'JSON' },
    ratio: { type: 'REAL' },
    tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
    deleted_at: { type: 'TIMESTAMP' },
    _meta_data: { type: 'JSON' },
  },
  indexes: [
    {
      name: 'events_slug_context_idx',
      columns: ['slug', 'context'],
      unique: true,
    },
    { name: 'events_tenant_id_idx', columns: ['tenant_id'] },
    {
      name: 'events_tenant_live_idx',
      columns: ['tenant_id'],
      where: '"deleted_at" IS NULL',
    },
    {
      name: 'events_meta_kind_idx',
      columns: [],
      jsonPath: { column: '_meta_data', path: 'kind' },
    },
  ],
  version: 'v1',
} as const;

describe('manifestSchemaToDefinition', () => {
  it('maps manifest columns (default → defaultValue) and keeps where/jsonPath on indexes', () => {
    const definition = manifestSchemaToDefinition(structuredEvent);

    expect(definition.tableName).toBe('events');
    expect(definition.ddl).toBe(CACHED_PREVIEW);
    expect(definition.columns.context).toEqual({
      type: 'TEXT',
      notNull: true,
      defaultValue: '',
    });
    expect(definition.columns.id).toEqual({
      type: 'UUID',
      primaryKey: true,
      notNull: true,
      referenceKind: 'id',
    });
    expect(definition.indexes.map((index) => index.name)).toEqual([
      'events_slug_context_idx',
      'events_tenant_id_idx',
      'events_tenant_live_idx',
      'events_meta_kind_idx',
    ]);
    expect(definition.indexes[2].where).toBe('"deleted_at" IS NULL');
    expect(definition.indexes[3].jsonPath).toEqual({
      column: '_meta_data',
      path: 'kind',
    });
  });

  it('accepts registry-style `defaultValue` as well as manifest-style `default`', () => {
    const definition = manifestSchemaToDefinition({
      tableName: 't',
      columns: {
        a: { type: 'TEXT', defaultValue: 'x' },
        b: { type: 'INTEGER', default: 0 },
      },
    });
    expect(definition.columns.a.defaultValue).toBe('x');
    expect(definition.columns.b.defaultValue).toBe(0);
  });
});

describe('collectManifestTables + renderCollectedManifestTable', () => {
  it('renders a structured table through the engine strategy, never the cached ddl', () => {
    const tables = collectManifestTables([
      { schema: structuredEvent, source: '@pkg:Event' },
    ]);
    const table = tables.get('events');
    expect(table?.structured).toBe(true);
    expect(table?.sources).toEqual(['@pkg:Event']);

    if (!table) throw new Error('events table missing');
    const pg = renderCollectedManifestTable(table, 'postgres');
    expect(pg.createTable).not.toBe(CACHED_PREVIEW);
    expect(pg.createTable).toContain('"id" uuid PRIMARY KEY NOT NULL');
    expect(pg.createTable).toContain('"payload" JSONB');
    expect(pg.createTable).toContain('"ratio" DOUBLE PRECISION');
    expect(pg.createTable).toContain('"deleted_at" TIMESTAMPTZ');
    expect(pg.indexes).toEqual([
      'CREATE UNIQUE INDEX IF NOT EXISTS "events_slug_context_idx" ON "events" ("slug", "context");',
      'CREATE INDEX IF NOT EXISTS "events_tenant_id_idx" ON "events" ("tenant_id");',
      'CREATE INDEX IF NOT EXISTS "events_tenant_live_idx" ON "events" ("tenant_id") WHERE "deleted_at" IS NULL;',
      'CREATE INDEX IF NOT EXISTS "events_meta_kind_idx" ON "events" (("_meta_data"->>\'kind\'));',
    ]);

    const sqlite = renderCollectedManifestTable(table, 'sqlite');
    expect(sqlite.createTable).toContain('"id" TEXT PRIMARY KEY NOT NULL');
    expect(sqlite.createTable).toContain('"payload" TEXT');
    expect(sqlite.createTable).toContain('"deleted_at" DATETIME');
    expect(sqlite.indexes[2]).toBe(
      'CREATE INDEX IF NOT EXISTS "events_tenant_live_idx" ON "events" ("tenant_id") WHERE "deleted_at" IS NULL;',
    );
    expect(sqlite.indexes[3]).toBe(
      'CREATE INDEX IF NOT EXISTS "events_meta_kind_idx" ON "events" ((json_extract("_meta_data", \'$.kind\')));',
    );
  });

  it('is exactly what the migration path renders for the same definition', () => {
    // Path parity (#2358): the migration orchestrator emits
    // strategy.generateCreateTable + generateIndexes + generateTriggers for a
    // new table. Consumers of raw manifests must land on the same statements.
    // TODO(#2359): fold into src/schema/schema-path-parity.test.ts once it lands.
    const tables = collectManifestTables([
      { schema: structuredEvent, source: '@pkg:Event' },
    ]);
    const table = tables.get('events');
    if (!table) throw new Error('events table missing');

    for (const engine of ['sqlite', 'postgres'] as const) {
      const strategy = getDDLStrategy(engine);
      const rendered = renderCollectedManifestTable(table, engine);
      expect(rendered.createTable).toBe(
        strategy.generateCreateTable(table.definition),
      );
      expect(rendered.indexes).toEqual(
        strategy.generateIndexes(table.definition),
      );
      expect(rendered.triggers).toEqual(
        strategy.generateTriggers(table.definition),
      );
    }
  });

  it('merges STI contributors structurally: columns first-wins, indexes deduplicated by name', () => {
    const base = {
      tableName: 'contents',
      columns: {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        title: { type: 'TEXT', notNull: true, default: '' },
      },
      indexes: [{ name: 'contents_meta_type_idx', columns: ['_meta_type'] }],
    };
    const child = {
      tableName: 'contents',
      columns: {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        // A subtype re-declaring `title` differently does not win.
        title: { type: 'TEXT' },
        meeting_id: { type: 'TEXT' },
      },
      indexes: [
        { name: 'contents_meta_type_idx', columns: ['_meta_type'] },
        { name: 'contents_meeting_id_idx', columns: ['meeting_id'] },
      ],
    };

    const tables = collectManifestTables([
      { schema: base, source: 'a:Content' },
      { schema: child, source: 'b:Agenda' },
    ]);
    const table = tables.get('contents');
    expect(table?.structured).toBe(true);
    expect(table?.sources).toEqual(['a:Content', 'b:Agenda']);
    expect(Object.keys(table?.definition.columns ?? {})).toEqual([
      'id',
      'title',
      'meeting_id',
    ]);
    expect(table?.definition.columns.title).toEqual({
      type: 'TEXT',
      notNull: true,
      defaultValue: '',
    });
    expect(table?.definition.indexes.map((index) => index.name)).toEqual([
      'contents_meta_type_idx',
      'contents_meeting_id_idx',
    ]);
  });

  it('falls back to the cached ddl only for column-less contributors, still rendering indexes', () => {
    const legacy = {
      tableName: 'legacy_things',
      ddl: 'CREATE TABLE IF NOT EXISTS "legacy_things" ("id" TEXT PRIMARY KEY NOT NULL, "occurred_at" TIMESTAMP, CHECK (length("id") > 0));',
      indexes: [
        { name: 'legacy_things_occurred_idx', columns: ['occurred_at'] },
      ],
    };
    const tables = collectManifestTables([
      { schema: legacy, source: 'x:LegacyThing' },
    ]);
    const table = tables.get('legacy_things');
    expect(table?.structured).toBe(false);
    if (!table) throw new Error('missing');

    const pg = renderCollectedManifestTable(table, 'postgres');
    // Cached string, made minimally PG-safe (bare TIMESTAMP → TIMESTAMPTZ).
    expect(pg.createTable).toContain('"occurred_at" TIMESTAMPTZ');
    expect(pg.createTable).toContain('CHECK (length("id") > 0)');
    // Indexes never lived in the string; they come from the strategy.
    expect(pg.indexes).toEqual([
      'CREATE INDEX IF NOT EXISTS "legacy_things_occurred_idx" ON "legacy_things" ("occurred_at");',
    ]);
  });

  it('merges a column-less contributor on top of the strategy render when contributors are mixed', () => {
    const structured = {
      tableName: 'contents',
      // A structured contributor need not carry a cached ddl at all.
      columns: {
        id: { type: 'UUID', primaryKey: true, notNull: true },
        title: { type: 'TEXT' },
        payload: { type: 'JSON' },
      },
      indexes: [],
    };
    const legacy = {
      tableName: 'contents',
      ddl: 'CREATE TABLE IF NOT EXISTS "contents" ("id" TEXT PRIMARY KEY NOT NULL, "title" TEXT, "meeting_id" TEXT, "seen_at" TIMESTAMP, CHECK (length("id") > 0));',
      indexes: [{ name: 'contents_meeting_id_idx', columns: ['meeting_id'] }],
    };
    const tables = collectManifestTables([
      { schema: structured, source: 'a:Content' },
      { schema: legacy, source: 'b:Agenda' },
    ]);
    const table = tables.get('contents');
    expect(table?.structured).toBe(false);
    if (!table) throw new Error('missing');

    const pg = renderCollectedManifestTable(table, 'postgres');
    // Structured contributor keeps its engine typing (not the legacy string's
    // "id" TEXT / "payload" JSON), the legacy-only columns and table
    // constraint are appended, and shared columns are not duplicated.
    expect(pg.createTable).toContain('"id" uuid PRIMARY KEY NOT NULL');
    expect(pg.createTable).toContain('"payload" JSONB');
    expect(pg.createTable).toContain('"meeting_id" TEXT');
    expect(pg.createTable).toContain('"seen_at" TIMESTAMPTZ');
    expect(pg.createTable).toContain('CHECK (length("id") > 0)');
    expect(pg.createTable.match(/"title" TEXT/g)).toHaveLength(1);
    expect(pg.createTable.match(/"id" /g)).toHaveLength(1);
    expect(pg.indexes).toEqual([
      'CREATE INDEX IF NOT EXISTS "contents_meeting_id_idx" ON "contents" ("meeting_id");',
    ]);
  });

  it('inlines UNIQUE for a column-less contributor on inline-unique engines (DuckDB/JSON)', () => {
    const legacy = {
      tableName: 'legacy_keys',
      ddl: 'CREATE TABLE IF NOT EXISTS "legacy_keys" ("id" TEXT PRIMARY KEY NOT NULL, "slug" TEXT NOT NULL, "context" TEXT NOT NULL, "tenant_id" TEXT, UNIQUE("tenant_id"));',
      indexes: [
        {
          name: 'legacy_keys_slug_context_idx',
          columns: ['slug', 'context'],
          unique: true,
        },
        // Already declared inline by the cached string — must not duplicate.
        {
          name: 'legacy_keys_tenant_id_idx',
          columns: ['tenant_id'],
          unique: true,
        },
        { name: 'legacy_keys_slug_idx', columns: ['slug'] },
      ],
    };
    const tables = collectManifestTables([
      { schema: legacy, source: 'x:LegacyKey' },
    ]);
    const table = tables.get('legacy_keys');
    if (!table) throw new Error('missing');

    for (const engine of ['duckdb', 'json'] as const) {
      const rendered = renderCollectedManifestTable(table, engine);
      // The strategy skips plain unique indexes on these engines...
      expect(rendered.indexes).toEqual([
        'CREATE INDEX IF NOT EXISTS "legacy_keys_slug_idx" ON "legacy_keys" ("slug");',
      ]);
      // ...so the uniqueness must be inline in the CREATE TABLE.
      expect(rendered.createTable).toContain('UNIQUE("slug", "context")');
      expect(rendered.createTable.match(/UNIQUE\("tenant_id"\)/g)).toHaveLength(
        1,
      );
    }

    // SQLite/PostgreSQL keep them as separate unique indexes, string untouched.
    const sqlite = renderCollectedManifestTable(table, 'sqlite');
    expect(sqlite.createTable).toBe(legacy.ddl);
    expect(sqlite.indexes[0]).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "legacy_keys_slug_context_idx" ON "legacy_keys" ("slug", "context");',
    );
  });

  it('skips objects with neither columns nor ddl', () => {
    const tables = collectManifestTables([
      { schema: { tableName: 'ghost' }, source: 'x:Ghost' },
    ]);
    expect(tables.size).toBe(0);
  });
});

describe('mergeSchemaDefinitionInto', () => {
  it('appends new columns and indexes without overwriting existing ones', () => {
    const target: SchemaDefinition = {
      tableName: 't',
      columns: { id: { type: 'TEXT', primaryKey: true } },
      indexes: [{ name: 't_a_idx', columns: ['a'] }],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '',
    };
    mergeSchemaDefinitionInto(target, {
      tableName: 't',
      columns: { id: { type: 'UUID' }, b: { type: 'INTEGER' } },
      indexes: [
        { name: 't_a_idx', columns: ['a'], unique: true },
        { name: 't_b_idx', columns: ['b'] },
      ],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '',
    });
    expect(target.columns.id).toEqual({ type: 'TEXT', primaryKey: true });
    expect(target.columns.b).toEqual({ type: 'INTEGER' });
    expect(target.indexes).toEqual([
      { name: 't_a_idx', columns: ['a'] },
      { name: 't_b_idx', columns: ['b'] },
    ]);
  });
});

describe('DDL strategies emit NOT NULL on primary keys (#2358)', () => {
  let db: DatabaseProvider | undefined;

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // ignore
      }
    }
    db = undefined;
  });

  const things: SchemaDefinition = {
    tableName: 'pk_things',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      name: { type: 'TEXT' },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '',
  };

  it('renders PRIMARY KEY NOT NULL on every engine', () => {
    for (const engine of ['sqlite', 'postgres', 'duckdb', 'json'] as const) {
      const sql = getDDLStrategy(engine).generateCreateTable(things);
      expect(sql, engine).toMatch(/"id" \S+ PRIMARY KEY NOT NULL/);
    }
  });

  it('SQLite rejects a NULL id once the strategy spells out NOT NULL', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(getDDLStrategy('sqlite').generateCreateTable(things));

    // Regression baseline: a bare TEXT PRIMARY KEY accepts NULL on SQLite.
    await db.query(
      'CREATE TABLE "pk_bare" ("id" TEXT PRIMARY KEY, "name" TEXT)',
    );
    await expect(
      db.query('INSERT INTO "pk_bare" ("id", "name") VALUES (NULL, ?)', 'x'),
    ).resolves.toBeDefined();

    await expect(
      db.query('INSERT INTO "pk_things" ("id", "name") VALUES (NULL, ?)', 'x'),
    ).rejects.toThrow();
    const rows = (await db.query(
      'SELECT COUNT(*) AS n FROM "pk_things"',
    )) as unknown as Array<{ n: number }> | { rows: Array<{ n: number }> };
    const [row] = Array.isArray(rows) ? rows : rows.rows;
    expect(Number(row.n)).toBe(0);
  });
});
