import {
  getSQLFromDiff,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { CatalogResourceCollection } from '../catalog-collections.js';
import type { CatalogResourceRepresentation } from '../catalog-contracts.js';
import { CatalogDatabaseSyncStore } from '../catalog-database-sync-store.js';

/** Exercise the ordinary additive manifest migration against a populated pre-column table. */
export async function assertRepresentationMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const schema = ObjectRegistry.getSchema('CatalogResource');
  if (!schema) throw new Error('CatalogResource manifest schema missing');
  const rows = await CatalogResourceCollection.create({ db });
  const legacy = await rows.create({
    providerId: 'migration',
    stableId: 'legacy',
    revision: 'v1',
    title: 'Legacy PDF',
    availableFormats: '["pdf"]',
    licenseEvidence: '{"state":"unknown"}',
  });
  await db.query(
    `ALTER TABLE "${schema.tableName}" DROP COLUMN "representation"`,
  );
  const diff = await new SchemaComparer(db, { engineHint: engine }).compare({
    [schema.tableName]: schema,
  });
  expect(diff.changes.filter((c) => c.type === 'add_column')).toMatchObject([
    { type: 'add_column', name: 'representation' },
  ]);
  const statements = getSQLFromDiff(diff).filter(
    (sql) => !sql.startsWith('--'),
  );
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('ADD COLUMN "representation"');
  for (const statement of statements) await db.query(statement);
  const restored = await rows.get(String(legacy.id));
  expect(restored?.stableId).toBe('legacy');
  expect(restored?.representation).toBeNull();
  expect(restored?.getRepresentation()).toBeUndefined();
  const representation: CatalogResourceRepresentation = {
    format: 'zip',
    mediaType: 'application/zip',
    byteLength: 92_253_588,
    validators: {
      etag: '"zip-v1"',
      lastModified: 'Wed, 14 Dec 2022 12:29:18 GMT',
    },
    acquisition: { status: 'unsupported-format' },
  };
  const store = new CatalogDatabaseSyncStore(db);
  await store.upsert(
    {
      providerId: 'migration',
      stableId: 'legacy',
      revision: 'v2',
      title: 'Observed ZIP',
      canonicalUrl: 'https://example.test',
      availableFormats: ['zip'],
      representation,
      visibility: 'catalog',
      licenseEvidence: {
        state: 'verified',
        permittedOperations: ['print', 'download'],
      },
    },
    'run',
  );
  const current = await rows.get(String(legacy.id));
  expect(current?.getRepresentation()).toEqual(representation);
  const before = current?.representation;
  await expect(
    store.upsert(
      {
        providerId: 'migration',
        stableId: 'legacy',
        revision: 'bad',
        title: 'Bad',
        canonicalUrl: 'https://example.test',
        representation: { format: 'pdf' } as CatalogResourceRepresentation,
        visibility: 'catalog',
        licenseEvidence: { state: 'unknown' },
      },
      'bad-run',
    ),
  ).rejects.toThrow('representation metadata');
  const unchanged = await rows.get(String(legacy.id));
  expect(unchanged?.revision).toBe('v2');
  expect(unchanged?.representation).toBe(before);
}
