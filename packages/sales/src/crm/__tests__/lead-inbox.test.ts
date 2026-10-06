/** Lead inbox filtering, pagination, enrichment, tenancy, and SQL parity. */

import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  TenantContextError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';

describe('LeadCollection.listInbox()', () => {
  let db: DatabaseInterface;
  let leads: LeadCollection;
  let activities: SalesActivityCollection;
  let representatives: SalesRepresentativeCollection;
  let tenantId: string;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase();
    leads = await LeadCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
    representatives = await SalesRepresentativeCollection.create({ db });
    tenantId = randomUUID();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function seedInbox() {
    const owner = await withTenant({ tenantId }, () =>
      representatives.create({
        profileId: randomUUID(),
        slug: randomUUID(),
        title: 'Account Executive',
      }),
    );
    const [alpha, beta, gamma, percent] = await withTenant(
      { tenantId },
      async () => [
        await leads.create({
          name: 'Alpha account',
          email: 'HELLO@ACME.TEST',
          ownerRepId: owner.id as string,
          status: 'new',
        }),
        await leads.create({ name: 'Beta prospect', status: 'working' }),
        await leads.create({ name: 'Gamma qualified', status: 'qualified' }),
        await leads.create({
          name: 'Literal 100% match',
          ownerRepId: owner.id as string,
          status: 'new',
        }),
      ],
    );
    await withTenant({ tenantId }, async () => {
      await activities.create({
        subjectKind: 'lead',
        subjectId: alpha.id as string,
        activityKind: 'task',
        summary: 'Later Alpha task',
        dueAt: new Date('2099-02-01T00:00:00.000Z'),
      });
      await activities.create({
        subjectKind: 'lead',
        subjectId: alpha.id as string,
        activityKind: 'task',
        summary: 'Next Alpha task',
        dueAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      await activities.create({
        subjectKind: 'lead',
        subjectId: beta.id as string,
        activityKind: 'task',
        summary: 'Overdue Beta task',
        dueAt: new Date('2000-01-01T00:00:00.000Z'),
      });
      await activities.create({
        subjectKind: 'opportunity',
        subjectId: gamma.id as string,
        activityKind: 'task',
        summary: 'Not a Lead task',
        dueAt: new Date('1999-01-01T00:00:00.000Z'),
      });
    });
    await db.query(
      'UPDATE leads SET created_at = ? WHERE id = ?',
      new Date('2026-01-01T00:00:00.000Z'),
      alpha.id,
    );
    await db.query(
      'UPDATE leads SET created_at = ? WHERE id = ?',
      new Date('2026-01-02T00:00:00.000Z'),
      beta.id,
    );
    await db.query(
      'UPDATE leads SET created_at = ? WHERE id = ?',
      new Date('2026-01-03T00:00:00.000Z'),
      gamma.id,
    );
    await db.query(
      'UPDATE leads SET created_at = ? WHERE id = ?',
      new Date('2026-01-04T00:00:00.000Z'),
      percent.id,
    );
    return { owner, alpha, beta, gamma, percent };
  }

  it('returns stable pages, explicit tab counts, and batched relationship projections', async () => {
    const { owner, alpha, beta } = await seedInbox();

    const originalQuery = db.query.bind(db);
    let queryCount = 0;
    db.query = ((...args: Parameters<DatabaseInterface['query']>) => {
      queryCount += 1;
      return originalQuery(...args);
    }) as DatabaseInterface['query'];
    const result = await withTenant({ tenantId }, () =>
      leads.listInbox({ limit: 2, offset: 0, sort: 'next_action' }),
    );
    db.query = originalQuery;

    expect(queryCount).toBe(4);
    expect(result.total).toBe(4);
    expect(result.statusCounts).toEqual({
      all: 4,
      new: 2,
      working: 1,
      qualified: 1,
      disqualified: 0,
      merged: 0,
      unassigned: 2,
      overdue: 1,
    });
    expect(result.leads.map((lead) => lead.id)).toEqual([beta.id, alpha.id]);
    expect(result.items.map((item) => item.lead.id)).toEqual([
      beta.id,
      alpha.id,
    ]);
    expect(result.items[0].owner).toBeNull();
    expect(result.items[0].nextAction?.summary).toBe('Overdue Beta task');
    expect(result.items[1].owner?.id).toBe(owner.id);
    expect(result.items[1].nextAction?.summary).toBe('Next Alpha task');
  });

  it('combines lifecycle, owner, derived, and literal case-insensitive search filters', async () => {
    const { owner, beta, percent } = await seedInbox();

    const overdue = await withTenant({ tenantId }, () =>
      leads.listInbox({
        status: 'working',
        unassigned: true,
        overdue: true,
        limit: 10,
        offset: 0,
      }),
    );
    expect(overdue.leads.map((lead) => lead.id)).toEqual([beta.id]);
    expect(overdue.total).toBe(1);

    const exactBoundary = await withTenant({ tenantId }, () =>
      leads.listInbox({
        overdue: true,
        now: new Date('2000-01-01T00:00:00.000Z'),
        limit: 10,
        offset: 0,
      }),
    );
    expect(exactBoundary.leads).toEqual([]);
    expect(exactBoundary.statusCounts.overdue).toBe(0);

    const literalWildcard = await withTenant({ tenantId }, () =>
      leads.listInbox({
        ownerRepId: owner.id as string,
        search: ' % ',
        limit: 10,
        offset: 0,
      }),
    );
    expect(literalWildcard.leads.map((lead) => lead.id)).toEqual([percent.id]);
    expect(literalWildcard.statusCounts.all).toBe(1);

    const email = await withTenant({ tenantId }, () =>
      leads.listInbox({ search: 'hello@acme', limit: 10, offset: 0 }),
    );
    expect(email.leads.map((lead) => lead.name)).toEqual(['Alpha account']);
  });

  it('keeps adjacent name pages deterministic and validates caller bounds', async () => {
    await seedInbox();
    const first = await withTenant({ tenantId }, () =>
      leads.listInbox({ sort: 'name', limit: 2, offset: 0 }),
    );
    const second = await withTenant({ tenantId }, () =>
      leads.listInbox({ sort: 'name', limit: 2, offset: 2 }),
    );
    expect([...first.leads, ...second.leads].map((lead) => lead.name)).toEqual([
      'Alpha account',
      'Beta prospect',
      'Gamma qualified',
      'Literal 100% match',
    ]);
    await expect(
      withTenant({ tenantId }, () => leads.listInbox({ limit: 0, offset: 0 })),
    ).rejects.toThrow(/limit must be an integer/);
    await expect(
      withTenant({ tenantId }, () =>
        leads.listInbox({ limit: 10, offset: -1 }),
      ),
    ).rejects.toThrow(/offset must be a non-negative integer/);
  });

  it('requires an ambient tenant and excludes foreign rows, tasks, owners, and counts', async () => {
    const { alpha } = await seedInbox();
    const foreignTenantId = randomUUID();
    await withTenant({ tenantId: foreignTenantId }, async () => {
      const foreignOwner = await representatives.create({
        profileId: randomUUID(),
        slug: randomUUID(),
      });
      const foreignLead = await leads.create({
        name: 'Foreign Alpha',
        ownerRepId: foreignOwner.id as string,
      });
      await activities.create({
        subjectKind: 'lead',
        subjectId: foreignLead.id as string,
        activityKind: 'task',
        summary: 'Foreign overdue task',
        dueAt: new Date('2000-01-01T00:00:00.000Z'),
      });
    });

    const result = await withTenant({ tenantId }, () =>
      leads.listInbox({ search: 'alpha', limit: 10, offset: 0 }),
    );
    expect(result.leads.map((lead) => lead.id)).toEqual([alpha.id]);
    expect(result.total).toBe(1);
    expect(result.statusCounts.all).toBe(1);
    await expect(
      leads.listInbox({ limit: 10, offset: 0 }),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe('LeadCollection.listInbox() on DuckDB', () => {
  it('uses the same tenant-safe filter, ordering, count, and hydration contract', async () => {
    enableTenancy();
    const db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Lead', 'SalesActivity', 'SalesRepresentative'],
      omitForeignKeyConstraints: true,
    });
    try {
      const leads = await LeadCollection.create({ db });
      const activities = await SalesActivityCollection.create({ db });
      const tenantId = randomUUID();
      const [later, overdue] = await withTenant({ tenantId }, async () => {
        const later = await leads.create({ name: 'Zulu' });
        const overdue = await leads.create({ name: 'Alpha' });
        await activities.create({
          subjectKind: 'lead',
          subjectId: overdue.id as string,
          activityKind: 'task',
          summary: 'DuckDB overdue task',
          dueAt: new Date('2000-01-01T00:00:00.000Z'),
        });
        return [later, overdue];
      });

      const result = await withTenant({ tenantId }, () =>
        leads.listInbox({ sort: 'next_action', limit: 10, offset: 0 }),
      );
      expect(result.leads.map((lead) => lead.id)).toEqual([
        overdue.id,
        later.id,
      ]);
      expect(result.items[0].nextAction?.dueAt).toBeInstanceOf(Date);
      expect(result.total).toBe(2);
      expect(result.statusCounts.overdue).toBe(1);
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
});
