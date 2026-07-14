/**
 * Tests for EarnerSourceAttribution (#1986): the indexed external
 * attribution association, idempotent registration (the metadata-migration
 * backfill primitive), single + batched active-earner resolution with
 * fail-closed refusals, bounded query work under heavy unrelated-earner
 * skew, and tenant isolation.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
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
    it('closes delete on every generated surface and registers the natural key', () => {
      const config = ObjectRegistry.getConfig('EarnerSourceAttribution');
      expect(config.conflictColumns).toEqual([
        'tenant_id',
        'source_kind',
        'source_id',
      ]);
      // Deactivation preserves the audit trail — a bare `true` on any
      // surface would regenerate the delete verb this contract closes.
      for (const surface of [config.api, config.mcp, config.cli] as {
        include?: string[];
      }[]) {
        expect(surface).toBeDefined();
        expect(surface.include).toBeDefined();
        expect(surface.include).not.toContain('delete');
      }
    });

    it('refuses a mapping whose tenant does not match its earner', async () => {
      const earner = await createEarner({ tenantId: 'tenant-a' });
      await expect(
        attributions.create({
          tenantId: 'tenant-b',
          earnerId: earner.id as string,
          sourceKind: KIND,
          sourceId: 'prop-incoherent',
        }),
      ).rejects.toThrow(/does not match earner tenant/);
      await expect(
        service.registerAttribution({
          earnerId: earner.id as string,
          sourceKind: KIND,
          sourceId: 'prop-incoherent',
          tenantId: null,
        }),
      ).rejects.toThrow(/does not match earner tenant/);
      // The coherent registration (defaulted to the earner's tenant) works.
      const ok = await service.registerAttribution({
        earnerId: earner.id as string,
        sourceKind: KIND,
        sourceId: 'prop-incoherent',
      });
      expect(ok.attribution.tenantId).toBe('tenant-a');
    });

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

      // Cross-tenant rows are NOT registration duplicates: re-registering
      // within tenant-a updates tenant-a's mapping only.
      const registered = await service.registerAttribution({
        earnerId: first.id as string,
        sourceKind: KIND,
        sourceId: 'prop-dup',
      });
      expect(registered.created).toBe(false);
      expect(registered.attribution.tenantId).toBe('tenant-a');

      // Repair: deactivate one duplicate — the key resolves again.
      rows[1].status = 'inactive';
      await rows[1].save();
      const repaired = await service.resolveActiveEarnerBySource({
        sourceKind: KIND,
        sourceId: 'prop-dup',
      });
      expect(repaired.earner?.id).toBe(first.id);
    });

    it('operator-context registration is tenant-scoped and never touches another tenant’s mapping', async () => {
      // Regression for the PR #2004 P1 review finding: without an active
      // tenant context, the update-vs-create decision must consider only
      // the TARGET tenant's rows for the key.
      const earnerA = await createEarner({ tenantId: 'tenant-a' });
      const earnerA2 = await createEarner({ tenantId: 'tenant-a' });
      const earnerB = await createEarner({ tenantId: 'tenant-b' });

      const forA = await service.registerAttribution({
        earnerId: earnerA.id as string,
        sourceKind: KIND,
        sourceId: 'prop-multi',
      });
      expect(forA.created).toBe(true);
      expect(forA.attribution.tenantId).toBe('tenant-a');

      // Same key for tenant-b: a NEW mapping, never a re-point of A's.
      const forB = await service.registerAttribution({
        earnerId: earnerB.id as string,
        sourceKind: KIND,
        sourceId: 'prop-multi',
      });
      expect(forB.created).toBe(true);
      expect(forB.previousEarnerId).toBeNull();
      expect(forB.attribution.tenantId).toBe('tenant-b');
      expect(forB.attribution.id).not.toBe(forA.attribution.id);

      // Re-pointing within tenant-a updates ONLY tenant-a's row.
      const repointA = await service.registerAttribution({
        earnerId: earnerA2.id as string,
        sourceKind: KIND,
        sourceId: 'prop-multi',
      });
      expect(repointA.created).toBe(false);
      expect(repointA.previousEarnerId).toBe(earnerA.id);
      expect(repointA.attribution.id).toBe(forA.attribution.id);
      const untouchedB = await attributions.get({
        id: forB.attribution.id as string,
      });
      expect(untouchedB?.earnerId).toBe(earnerB.id);
      expect(untouchedB?.tenantId).toBe('tenant-b');

      // A TRUE duplicate within one tenant scope still refuses
      // registration until repaired. The unique index makes this
      // impossible for non-NULL tenants (it just threw above the model
      // layer), so the only representable variant is the GLOBAL scope —
      // NULL tenants are distinct to the index.
      const globalEarner = await createEarner();
      await service.registerAttribution({
        earnerId: globalEarner.id as string,
        sourceKind: KIND,
        sourceId: 'prop-global-dup',
      });
      await db.query(
        `INSERT INTO earner_source_attributions (
          id, slug, context, tenant_id, earner_id, source_kind, source_id,
          status, metadata
        ) VALUES ($1, $2, '', NULL, $3, $4, 'prop-global-dup', 'active', '{}')`,
        '00000000-0000-4000-8000-00000000d0b1',
        'import-dup-prop-global',
        globalEarner.id,
        KIND,
      );
      await expect(
        service.registerAttribution({
          earnerId: globalEarner.id as string,
          sourceKind: KIND,
          sourceId: 'prop-global-dup',
        }),
      ).rejects.toThrow(/holds 2 active mappings in the target tenant scope/);

      // The documented repair — deactivate the extra — must actually
      // unblock registration (inactive duplicates stay for audit).
      const dupes = await attributions.findBySource(KIND, 'prop-global-dup');
      const extra = dupes.find(
        (row) => row.id === '00000000-0000-4000-8000-00000000d0b1',
      );
      if (!extra) throw new Error('expected the raw-SQL duplicate row');
      extra.status = 'inactive';
      await extra.save();
      const repaired = await service.registerAttribution({
        earnerId: globalEarner.id as string,
        sourceKind: KIND,
        sourceId: 'prop-global-dup',
      });
      expect(repaired.created).toBe(false);
      expect(repaired.attribution.isActive()).toBe(true);
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
