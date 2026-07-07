import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantIntegrationCollection } from '../collections/TenantIntegrationCollection.js';
import { TenantIntegration } from '../models/TenantIntegration.js';

describe('TenantIntegration', () => {
  let db: DatabaseInterface;
  let integrations: TenantIntegrationCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['TenantIntegration'],
    });
    integrations = await TenantIntegrationCollection.create({ db });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    if (typeof db.close === 'function') {
      await db.close();
    }
  });

  it('persists provider bookkeeping without secrets', async () => {
    const tenantId = randomUUID();

    const integration = await withTenant({ tenantId }, () =>
      integrations.create({
        tenantId,
        provider: 'aws',
        externalIds: {
          accountId: '123456789012',
          roleArn: 'arn:aws:iam::123456789012:role/Deploy',
        },
        status: 'provisioning',
      }),
    );

    expect(integration.status).toBe('provisioning');
    expect(integration.getExternalId('accountId')).toBe('123456789012');
    expect(integration.getExternalId('missing')).toBeUndefined();

    integration.recordDoctorRun({
      status: 'active',
      summary: [{ name: 'account exists', ok: true }],
    });
    await withTenant({ tenantId }, () => integration.save());

    const found = await withTenant({ tenantId }, () =>
      integrations.findFor(tenantId, 'aws'),
    );
    expect(found?.status).toBe('active');
    expect(found?.lastCheckSummary).toEqual([
      { name: 'account exists', ok: true },
    ]);
    expect(found?.lastError).toBeNull();
  });

  it('findOrInit reuses the natural key row', async () => {
    const tenantId = randomUUID();

    const first = await withTenant({ tenantId }, () =>
      integrations.findOrInit(tenantId, 'matomo'),
    );
    const second = await withTenant({ tenantId }, () =>
      integrations.findOrInit(tenantId, 'matomo'),
    );

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('unprovisioned');
  });

  it('supports setting and clearing external IDs', () => {
    const integration = new TenantIntegration({
      tenantId: randomUUID(),
      provider: 'aws',
    });

    integration.setExternalId('accountId', '123456789012');
    expect(integration.externalIds).toEqual({ accountId: '123456789012' });

    integration.setExternalId('accountId', undefined);
    expect(integration.externalIds).toEqual({});
  });

  it('filters rows by active tenant context', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    await withTenant({ tenantId: tenantA }, () =>
      integrations.create({
        tenantId: tenantA,
        provider: 'aws',
        status: 'active',
      }),
    );
    await withTenant({ tenantId: tenantB }, () =>
      integrations.create({
        tenantId: tenantB,
        provider: 'aws',
        status: 'active',
      }),
    );

    const tenantARows = await withTenant({ tenantId: tenantA }, () =>
      integrations.list({ orderBy: 'tenant_id ASC' }),
    );
    const tenantBRows = await withTenant({ tenantId: tenantB }, () =>
      integrations.listForTenant(tenantB),
    );

    expect(tenantARows).toHaveLength(1);
    expect(tenantARows[0].tenantId).toBe(tenantA);
    expect(tenantBRows).toHaveLength(1);
    expect(tenantBRows[0].tenantId).toBe(tenantB);
  });
});
