/**
 * Tenant isolation tests for the CRM module. Every model is
 * `@TenantScoped({ mode: 'optional' })`: under an ambient `withTenant()`
 * context rows auto-populate `tenantId` and reads auto-filter; without a
 * context rows stay global (`tenantId: null`).
 *
 * Mirrors `packages/products/src/sti-and-tenancy.test.ts` — real in-memory
 * SQLite, tenancy enabled, no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { OpportunityCollection } from '../collections/OpportunityCollection.js';
import { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';

describe('CRM tenant isolation', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase();
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('auto-populates tenantId on save when inside withTenant', async () => {
    const leads = await LeadCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const lead = await leads.create({ name: 'Tenant A lead' });
      expect(lead.tenantId).toBe('tenant-a');
    });
  });

  it('does not list tenant A rows under tenant B (leads)', async () => {
    const leads = await LeadCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await leads.create({ name: 'A1' });
      await leads.create({ name: 'A2' });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await leads.create({ name: 'B1' });
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const rows = await leads.list({});
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.tenantId === 'tenant-a')).toBe(true);
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const rows = await leads.list({});
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('B1');
    });
  });

  it('scopes rep finders to the ambient tenant', async () => {
    const reps = await SalesRepresentativeCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await reps.create({ profileId: 'profile-1', title: 'AE' });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await reps.create({ profileId: 'profile-1', title: 'SDR' });
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const active = await reps.findActive();
      expect(active).toHaveLength(1);
      expect(active[0].title).toBe('AE');
      const byProfile = await reps.findByProfile('profile-1');
      expect(byProfile).toHaveLength(1);
      expect(byProfile[0].tenantId).toBe('tenant-a');
    });
  });

  it('seeds one default pipeline per tenant', async () => {
    const pipelines = await PipelineDefinitionCollection.create({ db });

    const aResult = await withTenant({ tenantId: 'tenant-a' }, () =>
      pipelines.ensureDefaultPipeline(),
    );
    const bResult = await withTenant({ tenantId: 'tenant-b' }, () =>
      pipelines.ensureDefaultPipeline(),
    );

    expect(aResult.pipeline.id).not.toBe(bResult.pipeline.id);
    expect(aResult.pipeline.tenantId).toBe('tenant-a');
    expect(bResult.pipeline.tenantId).toBe('tenant-b');
    expect(aResult.stages).toHaveLength(7);
    expect(bResult.stages).toHaveLength(7);
    expect(aResult.stages.every((s) => s.tenantId === 'tenant-a')).toBe(true);

    // Re-running inside the tenant stays idempotent.
    const aAgain = await withTenant({ tenantId: 'tenant-a' }, () =>
      pipelines.ensureDefaultPipeline(),
    );
    expect(aAgain.pipeline.id).toBe(aResult.pipeline.id);
    expect(aAgain.stages).toHaveLength(7);

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      expect(await pipelines.list({})).toHaveLength(1);
    });
  });

  it('keeps the whole qualification flow inside the tenant', async () => {
    const leads = await LeadCollection.create({ db });
    const opportunities = await OpportunityCollection.create({ db });
    const activities = await SalesActivityCollection.create({ db });

    const opportunityId = await withTenant(
      { tenantId: 'tenant-a' },
      async () => {
        const lead = await leads.create({ name: 'Tenant A deal' });
        const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
        expect(opportunity.tenantId).toBe('tenant-a');
        return opportunity.id ?? '';
      },
    );

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      expect(await opportunities.list({})).toHaveLength(1);
      const trail = await activities.findBySubject(
        'opportunity',
        opportunityId,
      );
      expect(trail).toHaveLength(1);
      expect(trail[0].tenantId).toBe('tenant-a');
    });

    // Tenant B sees none of it.
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      expect(await opportunities.list({})).toHaveLength(0);
      expect(await leads.list({})).toHaveLength(0);
      expect(
        await activities.findBySubject('opportunity', opportunityId),
      ).toHaveLength(0);
    });
  });

  it('allows global (tenantId=null) rows when no context is set', async () => {
    const leads = await LeadCollection.create({ db });
    const lead = await leads.create({ name: 'Global reference lead' });
    expect(lead.tenantId).toBeNull();
  });
});
