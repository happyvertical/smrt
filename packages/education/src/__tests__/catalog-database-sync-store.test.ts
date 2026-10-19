import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import { CatalogResourceCollection } from '../catalog-collections.js';
import type { CatalogSourceRecord } from '../catalog-contracts.js';
import { CatalogDatabaseSyncStore } from '../catalog-database-sync-store.js';
import { CatalogSyncService } from '../catalog-sync-service.js';

const record = (stableId: string): CatalogSourceRecord => ({
  providerId: 'provider',
  stableId,
  revision: 'v1',
  canonicalUrl: `https://catalog.test/${stableId}`,
  title: stableId,
  visibility: 'catalog',
  licenseEvidence: { state: 'unknown' },
});

describe('CatalogDatabaseSyncStore', () => {
  it('persists the run generation across interruption and withdraws only unseen records after terminal resume', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CatalogResource', 'CatalogSyncState'],
    });
    try {
      const store = new CatalogDatabaseSyncStore(db);
      await store.upsert(record('old'), 'old-run');
      await new CatalogSyncService(store, 0).sync('provider', {
        enumerate: vi
          .fn()
          .mockResolvedValueOnce({
            records: [record('retained')],
            nextCursor: 'second',
            complete: false,
          })
          .mockRejectedValueOnce(new Error('interrupted')),
      });
      const interrupted = await store.getCheckpoint('provider');
      expect(interrupted).toMatchObject({ complete: false, cursor: 'second' });
      expect(interrupted?.runId).toBeTruthy();
      await new CatalogSyncService(store).sync('provider', {
        enumerate: async ({ cursor }) => {
          expect(cursor).toBe('second');
          return { records: [record('terminal')], complete: true };
        },
      });
      const resources = await CatalogResourceCollection.create({ db });
      const rows = await resources.list({ where: { providerId: 'provider' } });
      expect(rows.find((row) => row.stableId === 'retained')?.withdrawnAt).toBe(
        '',
      );
      expect(rows.find((row) => row.stableId === 'terminal')?.withdrawnAt).toBe(
        '',
      );
      expect(
        rows.find((row) => row.stableId === 'old')?.withdrawnAt,
      ).toBeTruthy();
      const complete = await store.getCheckpoint('provider');
      expect(complete).toMatchObject({ complete: true });
      expect(complete).not.toHaveProperty('runId');
    } finally {
      await db.close?.();
    }
  });
});
