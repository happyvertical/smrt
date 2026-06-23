/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-agents.
 *
 * AgentConfig / AgentSchedule are both `@TenantScoped({ mode: 'optional' })`
 * (CTI, own tables). Their collections used to expose:
 *   findGlobal()          → list({ where: { tenantId: null } })
 *   findWithGlobals(tid)   → raw `WHERE tenant_id = ? OR tenant_id IS NULL`
 * Under an ACTIVE tenant context with tenancy enabled (default `'throw'`
 * policy) BOTH throw: the explicit `tenant_id IS NULL` filter is flagged as an
 * isolation violation, and unflagged raw SQL on a tenant-scoped class is
 * blocked. `findWithGlobals` also trusted its caller-supplied `tenantId`.
 *
 * They now route through the shared `@happyvertical/smrt-tenancy` helpers, which
 * run raw with `{ allowRawOnTenantScoped: true }` and fail closed when an active
 * tenant context requests another tenant's rows (admin/system path keeps the
 * cross-tenant capability). Mirrors
 * `packages/ledgers/src/__tests__/ledgers-tenant-isolation.test.ts`.
 *
 * Real in-memory SQLite, no DB mocking, tenancy enabled under the default
 * `'throw'` policy, per `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentConfigCollection } from '../config.js';
import { AgentScheduleCollection } from '../schedule.js';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('agents tenant isolation (#1600)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('AgentConfigCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const configs = await AgentConfigCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await configs.create({
          agentId: 'a1',
          agentClass: 'Praeco',
          slotId: 't1-cfg',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await configs.create({
          agentId: 'a2',
          agentClass: 'Praeco',
          slotId: 't2-cfg',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await configs.create({
          agentId: 'ag',
          agentClass: 'Praeco',
          slotId: 'g-cfg',
        })
      ).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => configs.findGlobal()),
        'slotId',
      ),
    ).toEqual(['g-cfg']);

    // findWithGlobals returns the tenant's rows plus globals — never tenant-2's.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          configs.findWithGlobals('tenant-1'),
        ),
        'slotId',
      ),
    ).toEqual(['g-cfg', 't1-cfg']);

    // Fails closed for a tenant other than the active context.
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        configs.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);

    // System context keeps the deliberate cross-tenant admin capability.
    expect(
      sorted(
        await withSystemContext(() => configs.findWithGlobals('tenant-2')),
        'slotId',
      ),
    ).toEqual(['g-cfg', 't2-cfg']);
  });

  it('AgentScheduleCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const schedules = await AgentScheduleCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await schedules.create({
          agentType: 'Praeco',
          cron: '0 2 * * *',
          method: 't1-run',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await schedules.create({
          agentType: 'Praeco',
          cron: '0 3 * * *',
          method: 't2-run',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await schedules.create({
          agentType: 'Praeco',
          cron: '0 4 * * *',
          method: 'g-run',
        })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          schedules.findGlobal(),
        ),
        'method',
      ),
    ).toEqual(['g-run']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          schedules.findWithGlobals('tenant-1'),
        ),
        'method',
      ),
    ).toEqual(['g-run', 't1-run']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        schedules.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => schedules.findWithGlobals('tenant-2')),
        'method',
      ),
    ).toEqual(['g-run', 't2-run']);
  });
});
