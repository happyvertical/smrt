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
    expect(contents?.ddl).toContain('"meeting_id" TEXT');
    expect(contents?.ddl).toContain('"url" TEXT NOT NULL DEFAULT \'\'');
    expect(contents?.indexes).toContain(
      'CREATE INDEX IF NOT EXISTS "contents_meeting_id_idx" ON "contents" ("meeting_id");',
    );
    expect(result.sql).toContain('"meeting_id" TEXT');
  });

  it('inserts merged STI columns before trailing table constraints', () => {
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
            columns: {
              id: { type: 'TEXT', primaryKey: true, notNull: true },
              slug: { type: 'TEXT', notNull: true },
            },
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
            columns: {
              id: { type: 'TEXT', primaryKey: true, notNull: true },
              slug: { type: 'TEXT', notNull: true },
              meeting_id: { type: 'TEXT' },
            },
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
});
