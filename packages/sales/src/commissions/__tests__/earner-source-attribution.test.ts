/**
 * Tests for EarnerSourceAttribution (#1986): the indexed external
 * attribution association, idempotent registration (the metadata-migration
 * backfill primitive), single + batched active-earner resolution with
 * fail-closed refusals, bounded query work under heavy unrelated-earner
 * skew, and tenant isolation.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { EarnerSourceAttributionCollection } from '../collections/EarnerSourceAttributionCollection.js';
import type { Earner } from '../models/Earner.js';
import { EarnerAttributionService } from '../services/EarnerAttributionService.js';

const KIND = 'ad_network_property';

describe('EarnerSourceAttribution (#1986)', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let attributions: EarnerSourceAttributionCollection;
  let service: EarnerAttributionService;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
    attributions = await EarnerSourceAttributionCollection.create({ db });
    service = new EarnerAttributionService({ earners, attributions });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  let profileCounter = 0;
  async function createEarner(
    overrides: Record<string, unknown> = {},
  ): Promise<Earner> {
    profileCounter += 1;
    return await earners.create({
      profileId: `profile-${profileCounter}`,
      displayName: `Earner ${profileCounter}`,
      status: 'active',
      ...overrides,
    });
  }

  describe('model + registration', () => {
    it('requires earnerId, sourceKind, and sourceId to persist', async () => {
      const earner = await createEarner();
      await expect(
        attributions.create({
          earnerId: earner.id as string,
          sourceKind: KIND,
        }),
      ).rejects.toThrow(/required/);
      await expect(
        attributions.create({ sourceKind: KIND, sourceId: 'prop-x' }),
      ).rejects.toThrow(/required/);
    });

    it('registerAttribution creates once, then updates in place and reports the displaced earner', async () => {
      const first = await createEarner();
      const second = await createEarner();

      const created = await service.registerAttribution({
        earnerId: first.id as string,
        sourceKind: KIND,
        sourceId: 'prop-1',
      });
      expect(created.created).toBe(true);
      expect(created.previousEarnerId).toBeNull();
      expect(created.attribution.status).toBe('active');

      // Idempotent replay — the backfill loop can run any number of times.
      const replay = await service.registerAttribution({
        earnerId: first.id as string,
        sourceKind: KIND,
        sourceId: 'prop-1',
      });
      expect(replay.created).toBe(false);
      expect(replay.previousEarnerId).toBeNull();
      expect(replay.attribution.id).toBe(created.attribution.id);

      // Re-point: same key, different earner — updated in place, displaced
      // earner reported, still exactly one row.
      const repointed = await service.registerAttribution({
        earnerId: second.id as string,
        sourceKind: KIND,
        sourceId: 'prop-1',
      });
      expect(repointed.created).toBe(false);
      expect(repointed.previousEarnerId).toBe(first.id);
      expect(repointed.attribution.id).toBe(created.attribution.id);

      const rows = await attributions.findBySource(KIND, 'prop-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].earnerId).toBe(second.id);
    });

    it('registerAttribution refuses unknown earners and incomplete keys', async () => {
      await expect(
        service.registerAttribution({
          earnerId: '00000000-0000-4000-8000-000000000000',
          sourceKind: KIND,
          sourceId: 'prop-1',
        }),
      ).rejects.toThrow(/not found/);
      const earner = await createEarner();
      await expect(
        service.registerAttribution({
          earnerId: earner.id as string,
          sourceKind: '',
          sourceId: 'prop-1',
        }),
      ).rejects.toThrow(/required/);
    });

    it('generated create upserts on the natural key instead of duplicating (tenant-owned rows)', async () => {
      const first = await createEarner({ tenantId: 'tenant-a' });
      const second = await createEarner({ tenantId: 'tenant-a' });
      await attributions.create({
        tenantId: 'tenant-a',
        earnerId: first.id as string,
        sourceKind: KIND,
        sourceId: 'prop-9',
      });
      await attributions.create({
        tenantId: 'tenant-a',
        earnerId: second.id as string,
        sourceKind: KIND,
        sourceId: 'prop-9',
      });
      const rows = await attributions.findBySource(KIND, 'prop-9');
      expect(rows).toHaveLength(1);
      expect(rows[0].earnerId).toBe(second.id);
    });
  });

  describe('single resolution', () => {
    it('resolves the active earner for a mapped key', async () => {
      const earner = await createEarner();
      await service.registerAttribution({
        earnerId: earner.id as string,
        sourceKind: KIND,
        sourceId: 'prop-1',
      });

      const result = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-1',
      });
      expect(result.earner?.id).toBe(earner.id);
      expect(result.attribution?.sourceId).toBe('prop-1');
      expect(result.reason).toBeUndefined();
    });

    it('fails closed with typed reasons: no mapping, inactive mapping, inactive earner', async () => {
      const noMapping = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-none',
      });
      expect(noMapping.earner).toBeNull();
      expect(noMapping.reason).toBe('no_mapping');

      const earner = await createEarner();
      const { attribution } = await service.registerAttribution({
        earnerId: earner.id as string,
        sourceKind: KIND,
        sourceId: 'prop-2',
      });
      attribution.status = 'inactive';
      await attribution.save();
      const inactiveMapping = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-2',
      });
      expect(inactiveMapping.earner).toBeNull();
      expect(inactiveMapping.reason).toBe('mapping_inactive');

      const suspended = await createEarner({ status: 'suspended' });
      await service.registerAttribution({
        earnerId: suspended.id as string,
        sourceKind: KIND,
        sourceId: 'prop-3',
      });
      const inactiveEarner = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-3',
      });
      expect(inactiveEarner.earner).toBeNull();
      expect(inactiveEarner.reason).toBe('earner_not_active');
    });

    it('fails closed on ambiguous active mappings', async () => {
      // Two rows for one key CAN coexist (different tenants here; also
      // duplicate global rows minted outside the model layer — the
      // postgres suite covers that variant). Whenever a resolution scope
      // sees more than one active row for a key it must refuse, never
      // guess.
      const first = await createEarner({ tenantId: 'tenant-a' });
      const second = await createEarner({ tenantId: 'tenant-b' });
      await attributions.create({
        tenantId: 'tenant-a',
        earnerId: first.id as string,
        sourceKind: KIND,
        sourceId: 'prop-dup',
      });
      await attributions.create({
        tenantId: 'tenant-b',
        earnerId: second.id as string,
        sourceKind: KIND,
        sourceId: 'prop-dup',
      });
      const rows = await attributions.findBySource(KIND, 'prop-dup');
      expect(rows).toHaveLength(2);

      const result = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-dup',
      });
      expect(result.earner).toBeNull();
      expect(result.reason).toBe('ambiguous_mapping');

      // registerAttribution refuses to touch the ambiguous key until it
      // is repaired.
      await expect(
        service.registerAttribution({
          earnerId: first.id as string,
          sourceKind: KIND,
          sourceId: 'prop-dup',
        }),
      ).rejects.toThrow(/holds 2 mappings/);

      // Repair: deactivate one duplicate — the key resolves again.
      rows[1].status = 'inactive';
      await rows[1].save();
      const repaired = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-dup',
      });
      expect(repaired.earner?.id).toBe(first.id);
    });
  });

  describe('batched resolution', () => {
    it('resolves a batch with per-key outcomes and dedupes requested ids', async () => {
      const alpha = await createEarner();
      const beta = await createEarner();
      await service.registerAttribution({
        earnerId: alpha.id as string,
        sourceKind: KIND,
        sourceId: 'prop-a',
      });
      await service.registerAttribution({
        earnerId: beta.id as string,
        sourceKind: KIND,
        sourceId: 'prop-b',
      });

      const result = await service.resolveActiveEarnersBySources({
        sourceKind: KIND,
        sourceIds: ['prop-a', 'prop-b', 'prop-a', '', 'prop-missing'],
      });
      expect(result.earnersBySourceId.get('prop-a')?.id).toBe(alpha.id);
      expect(result.earnersBySourceId.get('prop-b')?.id).toBe(beta.id);
      expect(result.earnersBySourceId.size).toBe(2);
      expect(result.unresolved).toEqual([
        { sourceId: 'prop-missing', reason: 'no_mapping' },
      ]);
    });

    it('one earner mapped by several keys resolves for each key', async () => {
      const earner = await createEarner();
      for (const sourceId of ['prop-x', 'prop-y']) {
        await service.registerAttribution({
          earnerId: earner.id as string,
          sourceKind: KIND,
          sourceId,
        });
      }
      const result = await service.resolveActiveEarnersBySources({
        sourceKind: KIND,
        sourceIds: ['prop-x', 'prop-y'],
      });
      expect(result.earnersBySourceId.get('prop-x')?.id).toBe(earner.id);
      expect(result.earnersBySourceId.get('prop-y')?.id).toBe(earner.id);
    });

    it('keeps query work bounded by the requested ids under heavy unrelated-earner skew', async () => {
      // 300 unrelated ACTIVE earners, each with its own mapping — the old
      // metadata path would scan all of them per ingestion request.
      for (let i = 0; i < 300; i++) {
        const unrelated = await createEarner();
        await attributions.create({
          earnerId: unrelated.id as string,
          sourceKind: KIND,
          sourceId: `unrelated-${i}`,
        });
      }
      const wanted = await createEarner();
      await service.registerAttribution({
        earnerId: wanted.id as string,
        sourceKind: KIND,
        sourceId: 'prop-wanted',
      });

      // Count raw queries issued while resolving two keys. The db object
      // is real SQLite — the wrapper only counts pass-through calls.
      const originalQuery = db.query.bind(db);
      let queries = 0;
      db.query = (async (sql: string, ...vars: unknown[]) => {
        queries += 1;
        return await originalQuery(sql, ...vars);
      }) as DatabaseInterface['query'];
      try {
        const result = await service.resolveActiveEarnersBySources({
          sourceKind: KIND,
          sourceIds: ['prop-wanted', 'unrelated-7'],
        });
        expect(result.earnersBySourceId.get('prop-wanted')?.id).toBe(wanted.id);
        expect(result.earnersBySourceId.size).toBe(2);
        // One attribution IN query + one earner listByIds — bounded by the
        // requested keys, independent of the 300 unrelated active earners.
        expect(queries).toBeLessThanOrEqual(2);
      } finally {
        db.query = originalQuery;
      }
    });
  });

  describe('tenant isolation', () => {
    it('mappings resolve within the active tenant only', async () => {
      enableTenancy();
      const earnerA = await withTenant({ tenantId: 'tenant-a' }, async () => {
        const earner = await createEarner();
        await service.registerAttribution({
          earnerId: earner.id as string,
          sourceKind: KIND,
          sourceId: 'prop-shared',
        });
        return earner;
      });
      const earnerB = await withTenant({ tenantId: 'tenant-b' }, async () => {
        const earner = await createEarner();
        await service.registerAttribution({
          earnerId: earner.id as string,
          sourceKind: KIND,
          sourceId: 'prop-shared',
        });
        return earner;
      });

      // Same external key in both tenants — each tenant resolves its own
      // earner; neither sees the other's mapping.
      const seenByA = await withTenant({ tenantId: 'tenant-a' }, () =>
        service.resolveActiveEarnerBySource({
          sourceKind: KIND,
          sourceId: 'prop-shared',
        }),
      );
      expect(seenByA.earner?.id).toBe(earnerA.id);
      const seenByB = await withTenant({ tenantId: 'tenant-b' }, () =>
        service.resolveActiveEarnerBySource({
          sourceKind: KIND,
          sourceId: 'prop-shared',
        }),
      );
      expect(seenByB.earner?.id).toBe(earnerB.id);

      // Without tenant context (operator scope) BOTH rows are visible for
      // the same key — ambiguous, fail closed.
      const operatorView = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-shared',
      });
      expect(operatorView.earner).toBeNull();
      expect(operatorView.reason).toBe('ambiguous_mapping');
    });
  });
});
