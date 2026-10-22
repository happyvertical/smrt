import {
  getSQLFromDiff,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, vi } from 'vitest';
import { CatalogAcquisitionService } from '../catalog-acquisition-service.js';
import { evaluateCatalogAcquisitionCapability } from '../catalog-capability.js';
import { CatalogResourceCollection } from '../catalog-collections.js';
import type { CatalogResourceRepresentation } from '../catalog-contracts.js';
import { CatalogDatabaseSyncStore } from '../catalog-database-sync-store.js';
import { CatalogReadService } from '../catalog-read-service.js';

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
  for (const mediaType of [null, 'application/octet-stream']) {
    const unknown: CatalogResourceRepresentation = {
      ...representation,
      format: 'unknown',
      mediaType,
      acquisition: {
        status: 'unknown-format',
        reason:
          mediaType === null
            ? 'missing-content-type'
            : 'unrecognized-content-type',
      },
    };
    await store.upsert(
      {
        providerId: 'migration',
        stableId: 'legacy',
        revision: 'v2',
        title: 'Unknown representation',
        canonicalUrl: 'https://example.test',
        availableFormats: [],
        representation: unknown,
        visibility: 'catalog',
        licenseEvidence: {
          state: 'verified',
          permittedOperations: ['print', 'download'],
        },
      },
      'unknown-run',
    );
    const persisted = await rows.get(String(legacy.id));
    expect(persisted?.getRepresentation()).toEqual(unknown);
    expect(persisted?.availableFormats).toBe('[]');
    const resource = {
      id: String(legacy.id),
      providerId: 'migration',
      stableId: 'legacy',
      revision: 'v2',
      title: 'Unknown representation',
      canonicalUrl: 'https://example.test',
      availableFormats: JSON.parse(persisted?.availableFormats ?? '[]'),
      representation:
        persisted?.representation as unknown as CatalogResourceRepresentation,
      visibility: 'catalog' as const,
      licenseEvidence: JSON.parse(persisted?.licenseEvidence ?? '{}'),
    };
    expect(resource.licenseEvidence).toEqual({
      state: 'verified',
      permittedOperations: ['print', 'download'],
    });
    const actor = {
      tenantId: 'tenant',
      actorUserId: 'guardian',
      roles: ['guardian'],
    };
    const views = await new CatalogReadService({
      search: async () => [resource],
    }).search(actor);
    expect(views[0].representation).toEqual(unknown);
    expect(evaluateCatalogAcquisitionCapability(resource, 'pdf')).toMatchObject(
      { allowed: false, reason: 'unknown-format' },
    );
    const createAcquisition = vi.fn();
    const acquire = vi.fn();
    await expect(
      new CatalogAcquisitionService(
        {
          getResource: async () => ({ ...resource, withdrawnAt: null }),
          getSelection: async () => ({
            id: 'selection',
            tenantId: 'tenant',
            resourceId: resource.id,
            selectedRevision: 'v2',
          }),
          findAcquisition: async () => undefined,
          createAcquisition,
        },
        { acquire },
      ).acquire({
        ...actor,
        resourceId: resource.id,
        selectionId: 'selection',
        revision: 'v2',
        format: 'pdf',
        operation: 'print',
      }),
    ).rejects.toThrow('format is unavailable');
    expect(acquire).not.toHaveBeenCalled();
    expect(createAcquisition).not.toHaveBeenCalled();
  }
  const before = (await rows.get(String(legacy.id)))?.representation;
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
