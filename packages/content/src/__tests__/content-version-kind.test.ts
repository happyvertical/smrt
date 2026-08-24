import os from 'node:os';
import path from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { syncSchema } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import type { ContentVersionKind } from '../content-governance';
import '../content-feed-source';
import { Content } from '../content';
import { ContentVersionCollection } from '../content-versions';
import manifest from '../manifest/manifest.json';
import { serializeContentVersion } from '../serialization';

const CONTENT_VERSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  content_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT DEFAULT 'manual',
  title TEXT,
  description TEXT,
  body TEXT,
  status TEXT,
  summary TEXT,
  snapshot TEXT,
  metadata TEXT,
  tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS content_versions_id_idx ON content_versions (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_versions_content_id_version_idx ON content_versions (content_id, version);
`;

describe('ContentVersionKind', () => {
  it('persists, queries, updates, and serializes auto-generated versions', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: `file:${path.join(os.tmpdir(), `smrt-content-version-${crypto.randomUUID()}.db`)}`,
      classes: ['ContentFeedSource', 'Content', 'ContentVersion'],
    });
    try {
      await syncSchema({ db, schema: CONTENT_VERSIONS_SCHEMA });
      const versions = await ContentVersionCollection.create({ db });
      const kind: ContentVersionKind = 'auto-generated';
      const content = new Content({
        db,
        name: 'generated-version-parent',
        title: 'Generated version parent',
        status: 'draft',
      });
      await content.initialize();
      await content.save();

      const created = await versions.create({
        slug: 'generated-version-v1',
        contentId: content.id as string,
        version: 1,
        kind,
        summary: 'Created by planning-asset ingestion',
        snapshot: { title: 'Generated planning asset' },
        metadata: { source: 'planning-asset-ingestion' },
      });

      expect(created.kind).toBe('auto-generated');

      const queried = await versions.list({ where: { kind } });
      expect(queried).toHaveLength(1);
      expect(queried[0]?.kind).toBe('auto-generated');

      const persisted = queried[0];
      if (!persisted) throw new Error('Expected persisted content version');
      persisted.kind = 'manual';
      await persisted.save();
      persisted.kind = kind;
      persisted.summary = 'Generated snapshot retained';
      await persisted.save();

      const reloaded = await versions.get(created.id as string);
      expect(reloaded).toMatchObject({
        kind: 'auto-generated',
        summary: 'Generated snapshot retained',
      });
      expect(serializeContentVersion(reloaded)).toMatchObject({
        kind: 'auto-generated',
        snapshot: { title: 'Generated planning asset' },
        metadata: { source: 'planning-asset-ingestion' },
      });
    } finally {
      await db.close?.();
    }
  });

  it('keeps generated persistence surfaces text-backed and compatible', () => {
    const versionManifest = manifest.objects[
      '@happyvertical/smrt-content:ContentVersion'
    ] as {
      fields: { kind: { type: string; default?: string } };
      schema: {
        ddl: string;
        columns: { kind: { type: string; default?: string } };
      };
    };

    expect(versionManifest.fields.kind).toMatchObject({
      type: 'text',
      default: 'manual',
    });
    expect(versionManifest.schema.columns.kind).toMatchObject({
      type: 'TEXT',
      default: 'manual',
    });
    expect(versionManifest.schema.ddl).toContain(
      '"kind" TEXT DEFAULT \'manual\'',
    );
  });
});
