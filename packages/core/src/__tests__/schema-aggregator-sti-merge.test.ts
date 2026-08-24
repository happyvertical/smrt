import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SchemaAggregator } from '../schema/schema-aggregator.js';

function writeManifest(dir: string, fileName: string, manifest: unknown) {
  const filePath = join(dir, fileName);
  writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  return filePath;
}

describe('SchemaAggregator STI merge', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('plans manifest tables parent-first and defers PostgreSQL cycles (#2413)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schema-aggregator-fk-'));
    tempDirs.push(tempDir);

    const manifestPath = writeManifest(tempDir, 'fk.manifest.json', {
      packageName: '@test/fk',
      version: '1.0.0',
      objects: {
        Child: {
          className: 'Child',
          schema: {
            tableName: 'a_children',
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              parent_id: {
                type: 'TEXT',
                foreignKey: {
                  table: 'z_parents',
                  column: 'id',
                  onDelete: 'NO ACTION',
                  onUpdate: 'CASCADE',
                },
              },
            },
            indexes: [],
          },
        },
        Parent: {
          className: 'Parent',
          schema: {
            tableName: 'z_parents',
            columns: { id: { type: 'TEXT', primaryKey: true } },
            indexes: [],
          },
        },
      },
    });

    const result = new SchemaAggregator().aggregate({
      packages: ['@test/fk'],
      localPaths: { '@test/fk': manifestPath },
    });
    expect(result.sql.indexOf('-- Table: z_parents')).toBeLessThan(
      result.sql.indexOf('-- Table: a_children'),
    );

    const minimal = new SchemaAggregator().aggregate({
      packages: ['@test/fk'],
      localPaths: { '@test/fk': manifestPath },
      minimal: true,
      minimalSkipTables: ['z_parents'],
    });
    expect(minimal.sql).toContain('-- Table: a_children');
    expect(minimal.sql).not.toContain('-- Table: z_parents');
    expect(minimal.sql).not.toContain('FOREIGN KEY');
    expect(minimal.sql).not.toContain('REFERENCES "z_parents"');
    const minimalChild = minimal.tables.get('a_children');
    expect(minimalChild?.definition.foreignKeys).toEqual([]);
    expect(minimalChild?.definition.columns.parent_id?.foreignKey).toBe(
      undefined,
    );
    expect(minimalChild?.ddl).not.toContain('FOREIGN KEY');

    const cyclicPath = writeManifest(tempDir, 'cycle.manifest.json', {
      packageName: '@test/cycle',
      version: '1.0.0',
      objects: {
        Left: {
          className: 'Left',
          schema: {
            tableName: 'left_nodes',
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              right_id: {
                type: 'TEXT',
                foreignKey: {
                  table: 'right_nodes',
                  column: 'id',
                  onDelete: 'NO ACTION',
                  onUpdate: 'CASCADE',
                },
              },
            },
            indexes: [],
          },
        },
        Right: {
          className: 'Right',
          schema: {
            tableName: 'right_nodes',
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              left_id: {
                type: 'TEXT',
                foreignKey: {
                  table: 'left_nodes',
                  column: 'id',
                  onDelete: 'NO ACTION',
                  onUpdate: 'CASCADE',
                },
              },
            },
            indexes: [],
          },
        },
      },
    });
    const cycle = new SchemaAggregator().aggregate({
      packages: ['@test/cycle'],
      localPaths: { '@test/cycle': cyclicPath },
    });
    expect(cycle.sql.match(/ALTER TABLE .* ADD CONSTRAINT/g)).toHaveLength(2);
    expect(
      cycle.sql
        .slice(0, cycle.sql.indexOf('-- Deferred foreign-key constraints'))
        .includes('FOREIGN KEY'),
    ).toBe(false);
    for (const table of cycle.tables.values()) {
      expect(table.definition.foreignKeys).toEqual([]);
      expect(
        Object.values(table.definition.columns).every(
          (column) => column.foreignKey === undefined,
        ),
      ).toBe(true);
      expect(table.ddl).not.toContain('FOREIGN KEY');
    }
  });

  it('refuses minimal output when legacy cached DDL still references a filtered table', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schema-aggregator-legacy-fk-'));
    tempDirs.push(tempDir);
    const manifestPath = writeManifest(tempDir, 'legacy-fk.manifest.json', {
      packageName: '@test/legacy-fk',
      version: '1.0.0',
      objects: {
        ChildBase: {
          className: 'ChildBase',
          schema: {
            tableName: 'legacy_children',
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              parent_id: { type: 'TEXT' },
            },
            indexes: [],
          },
        },
        ChildLegacyContributor: {
          className: 'ChildLegacyContributor',
          schema: {
            tableName: 'legacy_children',
            ddl: 'CREATE TABLE legacy_children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES "public"."legacy_parents", sibling TEXT);',
            indexes: [],
          },
        },
        Parent: {
          className: 'Parent',
          schema: {
            tableName: 'legacy_parents',
            columns: { id: { type: 'TEXT', primaryKey: true } },
            indexes: [],
          },
        },
      },
    });

    expect(() =>
      new SchemaAggregator().aggregate({
        packages: ['@test/legacy-fk'],
        localPaths: { '@test/legacy-fk': manifestPath },
        minimal: true,
        minimalSkipTables: ['legacy_parents'],
      }),
    ).toThrow(/legacy cached DDL.*references filtered table/);
  });

  it('merges STI child columns across package manifests for shared tables', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schema-aggregator-sti-'));
    tempDirs.push(tempDir);

    const contentManifestPath = writeManifest(
      tempDir,
      'smrt-content.manifest.json',
      {
        packageName: '@happyvertical/smrt-content',
        version: '1.0.0',
        objects: {
          '@happyvertical/smrt-content:Content': {
            className: 'Content',
            schema: {
              tableName: 'contents',
              ddl: `CREATE TABLE IF NOT EXISTS "contents" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "_meta_type" TEXT NOT NULL DEFAULT '',
  "_meta_data" JSON,
  "payload" TEXT DEFAULT $$a,b(c)$$,
  "title" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL DEFAULT '',
  "tenant_id" UUID
);`,
              columns: {
                id: { type: 'TEXT', primaryKey: true, notNull: true },
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
                _meta_type: { type: 'TEXT', notNull: true, defaultValue: '' },
                _meta_data: { type: 'JSON' },
                payload: { type: 'TEXT' },
                title: { type: 'TEXT', notNull: true, defaultValue: '' },
                body: { type: 'TEXT', notNull: true, defaultValue: '' },
                tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
              },
              indexes: [],
            },
          },
        },
      },
    );

    const praecoManifestPath = writeManifest(tempDir, 'praeco.manifest.json', {
      packageName: '@happyvertical/praeco',
      version: '1.0.0',
      objects: {
        '@happyvertical/praeco:Agenda': {
          className: 'Agenda',
          schema: {
            tableName: 'contents',
            ddl: `CREATE TABLE IF NOT EXISTS "contents" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "_meta_type" TEXT NOT NULL DEFAULT '',
  "_meta_data" JSON,
  "title" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL DEFAULT '',
  "tenant_id" UUID,
  "meeting_id" TEXT,
  "url" TEXT NOT NULL DEFAULT ''
);`,
            columns: {
              id: { type: 'TEXT', primaryKey: true, notNull: true },
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
              _meta_type: { type: 'TEXT', notNull: true, defaultValue: '' },
              _meta_data: { type: 'JSON' },
              title: { type: 'TEXT', notNull: true, defaultValue: '' },
              body: { type: 'TEXT', notNull: true, defaultValue: '' },
              tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
              meeting_id: { type: 'TEXT' },
              url: { type: 'TEXT', notNull: true, defaultValue: '' },
            },
            indexes: [
              {
                name: 'contents_meeting_id_idx',
                columns: ['meeting_id'],
              },
            ],
          },
        },
      },
    });

    const aggregator = new SchemaAggregator();
    const result = aggregator.aggregate({
      packages: ['@happyvertical/smrt-content', '@happyvertical/praeco'],
      localPaths: {
        '@happyvertical/smrt-content': contentManifestPath,
        '@happyvertical/praeco': praecoManifestPath,
      },
    });

    const contents = result.tables.get('contents');
    expect(contents).toBeDefined();
    expect(contents?.sources).toEqual([
      '@happyvertical/smrt-content:Content',
      '@happyvertical/praeco:Agenda',
    ]);
    // Rendered from the merged structured columns through the PostgreSQL
    // strategy (#2358) — the cached `ddl` string is not what ships.
    expect(contents?.ddl).toContain('"id" TEXT PRIMARY KEY NOT NULL');
    expect(contents?.ddl).toContain('"meeting_id" TEXT');
    expect(contents?.ddl).toContain('"url" TEXT NOT NULL DEFAULT \'\'');
    expect(contents?.ddl).toContain('"created_at" TIMESTAMPTZ');
    expect(contents?.ddl).toContain('"updated_at" TIMESTAMPTZ');
    expect(contents?.ddl).toContain('"_meta_data" JSONB');
    expect(contents?.ddl).toContain('"tenant_id" uuid');
    // The structured column says `payload: TEXT` with no default; the cached
    // string's `$$a,b(c)$$` default is not authoritative.
    expect(contents?.ddl).toMatch(/"payload" TEXT[,\n]/);
    expect(contents?.ddl).not.toContain('$$a,b(c)$$');
    expect(contents?.ddl).not.toMatch(
      /"(?:created_at|updated_at)"\s+TIMESTAMP\b/,
    );
    expect(contents?.indexes).toContain(
      'CREATE INDEX IF NOT EXISTS "contents_meeting_id_idx" ON "contents" ("meeting_id");',
    );
    expect(Object.keys(contents?.columns ?? {})).toEqual(
      expect.arrayContaining(['meeting_id', 'url', 'payload']),
    );
    expect(result.sql).toContain('"meeting_id" TEXT');
    expect(result.sql).toContain('"created_at" TIMESTAMPTZ');
    expect(result.sql).toContain('"contents_meeting_id_idx"');
  });

  it('renders partial and JSON-path indexes through the dialect strategy (#2358)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schema-aggregator-indexes-'));
    tempDirs.push(tempDir);

    const manifestPath = writeManifest(tempDir, 'events.manifest.json', {
      packageName: '@happyvertical/events',
      version: '1.0.0',
      objects: {
        '@happyvertical/events:Event': {
          className: 'Event',
          schema: {
            tableName: 'events',
            ddl: 'CREATE TABLE IF NOT EXISTS "events" ("id" TEXT PRIMARY KEY NOT NULL);',
            columns: {
              id: { type: 'UUID', primaryKey: true, notNull: true },
              tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
              _meta_type: { type: 'TEXT', notNull: true, default: '' },
              _meta_data: { type: 'JSON' },
              deleted_at: { type: 'TIMESTAMP' },
            },
            indexes: [
              { name: 'events_tenant_id_idx', columns: ['tenant_id'] },
              {
                name: 'events_tenant_active_idx',
                columns: ['tenant_id'],
                unique: true,
                where: '"deleted_at" IS NULL',
              },
              {
                name: 'events_meta_kind_idx',
                columns: [],
                jsonPath: { column: '_meta_data', path: 'kind' },
              },
            ],
          },
        },
      },
    });

    const postgres = new SchemaAggregator().aggregate({
      packages: ['@happyvertical/events'],
      localPaths: { '@happyvertical/events': manifestPath },
      dialect: 'postgres',
    });
    const pgEvents = postgres.tables.get('events');
    expect(pgEvents?.ddl).toContain('"id" uuid PRIMARY KEY NOT NULL');
    expect(pgEvents?.ddl).toContain('"_meta_data" JSONB');
    expect(pgEvents?.ddl).toContain('"deleted_at" TIMESTAMPTZ');
    // Manifest `default` (not `defaultValue`) is honoured.
    expect(pgEvents?.ddl).toContain('"_meta_type" TEXT NOT NULL DEFAULT \'\'');
    expect(pgEvents?.indexes).toEqual([
      'CREATE INDEX IF NOT EXISTS "events_tenant_id_idx" ON "events" ("tenant_id");',
      'CREATE UNIQUE INDEX IF NOT EXISTS "events_tenant_active_idx" ON "events" ("tenant_id") WHERE "deleted_at" IS NULL;',
      'CREATE INDEX IF NOT EXISTS "events_meta_kind_idx" ON "events" (("_meta_data"->>\'kind\'));',
    ]);

    const sqlite = new SchemaAggregator().aggregate({
      packages: ['@happyvertical/events'],
      localPaths: { '@happyvertical/events': manifestPath },
      dialect: 'sqlite',
    });
    const liteEvents = sqlite.tables.get('events');
    expect(liteEvents?.ddl).toContain('"id" TEXT PRIMARY KEY NOT NULL');
    expect(liteEvents?.ddl).toContain('"_meta_data" TEXT');
    expect(liteEvents?.ddl).toContain('"deleted_at" DATETIME');
    expect(liteEvents?.indexes).toEqual([
      'CREATE INDEX IF NOT EXISTS "events_tenant_id_idx" ON "events" ("tenant_id");',
      'CREATE UNIQUE INDEX IF NOT EXISTS "events_tenant_active_idx" ON "events" ("tenant_id") WHERE "deleted_at" IS NULL;',
      'CREATE INDEX IF NOT EXISTS "events_meta_kind_idx" ON "events" ((json_extract("_meta_data", \'$.kind\')));',
    ]);
    expect(sqlite.sql).toContain('PRAGMA foreign_keys = ON;');
    expect(sqlite.sql).toContain('WHERE "deleted_at" IS NULL');
  });

  it('degrades a table to the cached-DDL merge when one STI contributor exposes no columns', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schema-aggregator-mixed-'));
    tempDirs.push(tempDir);

    const baseManifestPath = writeManifest(tempDir, 'base.manifest.json', {
      packageName: '@happyvertical/base',
      version: '1.0.0',
      objects: {
        '@happyvertical/base:Content': {
          className: 'Content',
          schema: {
            tableName: 'contents',
            ddl: 'CREATE TABLE IF NOT EXISTS "contents" ("id" TEXT PRIMARY KEY NOT NULL, "title" TEXT);',
            columns: {
              id: { type: 'TEXT', primaryKey: true, notNull: true },
              title: { type: 'TEXT' },
            },
            indexes: [{ name: 'contents_title_idx', columns: ['title'] }],
          },
        },
      },
    });
    const legacyManifestPath = writeManifest(tempDir, 'legacy.manifest.json', {
      packageName: '@happyvertical/legacy',
      version: '1.0.0',
      objects: {
        '@happyvertical/legacy:Agenda': {
          className: 'Agenda',
          schema: {
            tableName: 'contents',
            // Hand-authored manifest: cached DDL only, no structured columns.
            ddl: 'CREATE TABLE IF NOT EXISTS "contents" ("id" TEXT PRIMARY KEY NOT NULL, "title" TEXT, "meeting_id" TEXT, CHECK (length("id") > 0));',
            indexes: [
              { name: 'contents_meeting_id_idx', columns: ['meeting_id'] },
            ],
          },
        },
      },
    });

    const result = new SchemaAggregator().aggregate({
      packages: ['@happyvertical/base', '@happyvertical/legacy'],
      localPaths: {
        '@happyvertical/base': baseManifestPath,
        '@happyvertical/legacy': legacyManifestPath,
      },
      dialect: 'sqlite',
    });

    const contents = result.tables.get('contents');
    expect(contents?.sources).toEqual([
      '@happyvertical/base:Content',
      '@happyvertical/legacy:Agenda',
    ]);
    // Both contributors' columns survive, via the cached-string merge, and
    // the legacy contributor's table constraint is preserved.
    expect(contents?.ddl).toContain('"meeting_id" TEXT');
    expect(contents?.ddl).toContain('"title" TEXT');
    expect(contents?.ddl).toContain('CHECK (length("id") > 0)');
    // Indexes always come from the structured `indexes` arrays.
    expect(contents?.indexes).toEqual([
      'CREATE INDEX IF NOT EXISTS "contents_title_idx" ON "contents" ("title");',
      'CREATE INDEX IF NOT EXISTS "contents_meeting_id_idx" ON "contents" ("meeting_id");',
    ]);
  });

  it('inserts merged STI columns before trailing table constraints (cached-DDL fallback for column-less manifests)', () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), 'schema-aggregator-sti-constraints-'),
    );
    tempDirs.push(tempDir);

    const baseManifestPath = writeManifest(tempDir, 'base.manifest.json', {
      packageName: '@happyvertical/base',
      version: '1.0.0',
      objects: {
        '@happyvertical/base:Content': {
          className: 'Content',
          schema: {
            tableName: 'contents',
            ddl: `CREATE TABLE IF NOT EXISTS "contents" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  UNIQUE("slug")
);`,
            indexes: [],
          },
        },
      },
    });

    const childManifestPath = writeManifest(tempDir, 'child.manifest.json', {
      packageName: '@happyvertical/child',
      version: '1.0.0',
      objects: {
        '@happyvertical/child:Agenda': {
          className: 'Agenda',
          schema: {
            tableName: 'contents',
            ddl: `CREATE TABLE IF NOT EXISTS "contents" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "meeting_id" TEXT,
  UNIQUE("slug")
);`,
            indexes: [],
          },
        },
      },
    });

    const aggregator = new SchemaAggregator();
    const result = aggregator.aggregate({
      packages: ['@happyvertical/base', '@happyvertical/child'],
      localPaths: {
        '@happyvertical/base': baseManifestPath,
        '@happyvertical/child': childManifestPath,
      },
    });

    const contents = result.tables.get('contents');
    expect(contents).toBeDefined();
    expect(contents?.ddl).toContain('"meeting_id" TEXT');
    expect(contents?.ddl).toMatch(/"meeting_id" TEXT,\n\s+UNIQUE\("slug"\)/);
  });

  it('merges cached DDL for column-less manifests when quoted table names and comments contain parentheses', () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), 'schema-aggregator-sti-quoted-parens-'),
    );
    tempDirs.push(tempDir);

    const baseManifestPath = writeManifest(tempDir, 'base.manifest.json', {
      packageName: '@happyvertical/base',
      version: '1.0.0',
      objects: {
        '@happyvertical/base:Event': {
          className: 'Event',
          schema: {
            tableName: 'events(v2)',
            ddl: `CREATE TABLE IF NOT EXISTS "events(v2)" (
  /* base column (required) */
  "id" TEXT PRIMARY KEY NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "label" TEXT,
  NOT NULL created_at NO INHERIT,
  CHECK (label <> 'a  b'),
  CONSTRAINT repeated_check CHECK (id <> '')
);`,
            indexes: [],
          },
        },
      },
    });

    const childManifestPath = writeManifest(tempDir, 'child.manifest.json', {
      packageName: '@happyvertical/child',
      version: '1.0.0',
      objects: {
        '@happyvertical/child:ScheduledEvent': {
          className: 'ScheduledEvent',
          schema: {
            tableName: 'events(v2)',
            ddl: `CREATE TABLE IF NOT EXISTS "events(v2)" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "label" TEXT,
  /* child column (optional) */
  "starts_at" TIMESTAMP,
  NOT NULL created_at NO INHERIT,
  NOT NULL starts_at,
  CHECK (label <> 'a  b'),
  CHECK (label <> 'a b'),
  constraint repeated_check check(id<>'')
);`,
            indexes: [],
          },
        },
      },
    });

    const result = new SchemaAggregator().aggregate({
      packages: ['@happyvertical/base', '@happyvertical/child'],
      localPaths: {
        '@happyvertical/base': baseManifestPath,
        '@happyvertical/child': childManifestPath,
      },
    });

    const events = result.tables.get('events(v2)');
    expect(events?.ddl).toContain('CREATE TABLE IF NOT EXISTS "events(v2)" (');
    expect(events?.ddl).toContain('/* base column (required) */');
    expect(events?.ddl).toContain('/* child column (optional) */');
    expect(events?.ddl).toContain('"starts_at" TIMESTAMPTZ');
    expect(events?.ddl).toContain('NOT NULL created_at NO INHERIT');
    expect(events?.ddl).toContain('NOT NULL starts_at');
    expect(events?.ddl).toContain("CHECK (label <> 'a  b')");
    expect(events?.ddl).toContain("CHECK (label <> 'a b')");
    expect(events?.ddl?.match(/NOT NULL created_at NO INHERIT/g)).toHaveLength(
      1,
    );
    expect(events?.ddl?.match(/repeated_check/gi)).toHaveLength(1);
    expect(events?.ddl).not.toContain('CREATE TABLE IF NOT EXISTS "events\n');
    expect(result.sql).toContain('"starts_at" TIMESTAMPTZ');
  });
});
