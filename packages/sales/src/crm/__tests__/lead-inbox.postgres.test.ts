/** PostgreSQL parity proof for the bounded tenant-safe Lead inbox. */

import { randomUUID } from 'node:crypto';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('LeadCollection.listInbox() on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let leads: LeadCollection;
  let activities: SalesActivityCollection;
  let representatives: SalesRepresentativeCollection;

  beforeEach(async () => {
    enableTenancy();
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Lead', 'SalesActivity', 'SalesRepresentative'],
    });
    db = isolated.baseDb;
    leads = await LeadCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
    representatives = await SalesRepresentativeCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('filters, sorts, paginates, counts, and enriches within the ambient tenant', async () => {
    const tenantId = randomUUID();
    const foreignTenantId = randomUUID();
    const { first, second, owner } = await withTenant(
      { tenantId },
      async () => {
        const owner = await representatives.create({
          profileId: randomUUID(),
          slug: randomUUID(),
        });
        const first = await leads.create({
          name: 'First PostgreSQL lead',
          ownerRepId: owner.id as string,
        });
        const second = await leads.create({
          name: 'Second PostgreSQL lead',
          status: 'working',
        });
        await activities.create({
          subjectKind: 'lead',
          subjectId: second.id as string,
          activityKind: 'task',
          summary: 'PostgreSQL overdue task',
          dueAt: new Date('2000-01-01T00:00:00.000Z'),
        });
        return { first, second, owner };
      },
    );
    await withTenant({ tenantId: foreignTenantId }, () =>
      leads.create({ name: 'Foreign PostgreSQL lead', status: 'working' }),
    );

    const result = await withTenant({ tenantId }, () =>
      leads.listInbox({ sort: 'next_action', limit: 1, offset: 0 }),
    );
    expect(result.leads.map((lead) => lead.id)).toEqual([second.id]);
    expect(result.items[0].nextAction?.summary).toBe('PostgreSQL overdue task');
    expect(result.total).toBe(2);
    expect(result.statusCounts).toMatchObject({
      all: 2,
      new: 1,
      working: 1,
      unassigned: 1,
      overdue: 1,
    });

    const assigned = await withTenant({ tenantId }, () =>
      leads.listInbox({
        ownerRepId: owner.id as string,
        search: 'first postgresql',
        limit: 10,
        offset: 0,
      }),
    );
    expect(assigned.leads.map((lead) => lead.id)).toEqual([first.id]);
    expect(assigned.items[0].owner?.id).toBe(owner.id);
  });
});
