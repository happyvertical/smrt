import {
  getSQLFromDiff,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { CatalogResourceCollection } from '../catalog-collections.js';
import type { CatalogSourceRecord } from '../catalog-contracts.js';
import { CatalogDatabaseSyncStore } from '../catalog-database-sync-store.js';
import type { CatalogPreview } from '../catalog-preview.js';
import { CatalogReadService } from '../catalog-read-service.js';

/** Identical populated-table migration/retry/revision test on SQLite and PostgreSQL. */
export async function assertCatalogPreviewPersistence(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const schema = ObjectRegistry.getSchema('CatalogResource');
  if (!schema) throw new Error('Missing CatalogResource schema');
  const rows = await CatalogResourceCollection.create({ db });
  const legacy = await rows.create({
    providerId: 'illustrative-mathematics',
    stableId: 'legacy-preview',
    revision: 'v0',
    title: 'Legacy',
  });
  await db.query(`ALTER TABLE "${schema.tableName}" DROP COLUMN "preview"`);
  const diff = await new SchemaComparer(db, { engineHint: engine }).compare({
    [schema.tableName]: schema,
  });
  const statements = getSQLFromDiff(diff).filter(
    (sql) => !sql.startsWith('--'),
  );
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('ADD COLUMN "preview"');
  for (const statement of statements) await db.query(statement);
  expect((await rows.get(String(legacy.id)))?.getPreview()).toBeUndefined();
  const preview: CatalogPreview = {
    providerId: 'illustrative-mathematics',
    stableId: 'legacy-preview',
    revision: 'v1',
    reference: 'fd1cykl2wl4zyfc6vzfkl3x09pvr',
    mediaType: 'image/png',
    width: 1350,
    height: 674,
    byteLength: 93072,
    sha256: 'a'.repeat(64),
    alt: 'Tally chart',
    rights: {
      state: 'verified',
      identifier: 'CC-BY-4.0',
      sourceUrl:
        'https://im.kendallhunt.com/k5/families/grade-1/unit-1/family-materials.html',
      attribution: '© 2021 Illustrative Mathematics',
      retrievedAt: '2026-10-28T00:00:00.000Z',
    },
  };
  const record: CatalogSourceRecord = {
    providerId: preview.providerId,
    stableId: preview.stableId,
    revision: 'v1',
    title: 'Preview',
    canonicalUrl: preview.rights.sourceUrl,
    visibility: 'catalog',
    licenseEvidence: { state: 'restricted' },
    preview,
  };
  const store = new CatalogDatabaseSyncStore(db);
  await store.upsert(record, 'first');
  await store.upsert(
    {
      ...record,
      preview: {
        ...preview,
        rights: { ...preview.rights, retrievedAt: '2026-10-29T00:00:00.000Z' },
      },
    },
    'retry',
  );
  let current = await rows.get(String(legacy.id));
  expect(current?.getPreview()).toEqual(preview);
  const views = await new CatalogReadService({
    search: async () => [
      { ...record, id: String(legacy.id), preview: current?.getPreview() },
    ],
  }).search({
    tenantId: 'tenant',
    actorUserId: 'guardian',
    roles: ['guardian'],
  });
  expect(views[0].preview).toEqual(preview);
  await expect(
    store.upsert(
      { ...record, preview: { ...preview, sha256: 'b'.repeat(64) } },
      'invalid',
    ),
  ).rejects.toThrow('immutable');
  expect((await rows.get(String(legacy.id)))?.getPreview()).toEqual(preview);
  await store.upsert({ ...record, revision: 'v2', preview: undefined }, 'next');
  current = await rows.get(String(legacy.id));
  expect(current?.revision).toBe('v2');
  expect(current?.getPreview()).toBeUndefined();
  await store.upsert(
    {
      ...record,
      revision: 'v3',
      preview: {
        ...preview,
        revision: 'v3',
        rights: { ...preview.rights, expiresAt: '2000-01-01T00:00:00.000Z' },
      },
    },
    'expired',
  );
  current = await rows.get(String(legacy.id));
  expect(current?.getPreview()?.rights.expiresAt).toBe(
    '2000-01-01T00:00:00.000Z',
  );
  const expiredViews = await new CatalogReadService({
    search: async () => [
      {
        ...record,
        id: String(legacy.id),
        revision: 'v3',
        preview: current?.getPreview(),
      },
    ],
  }).search({
    tenantId: 'tenant',
    actorUserId: 'guardian',
    roles: ['guardian'],
  });
  expect(expiredViews[0].preview).toBeUndefined();
}
