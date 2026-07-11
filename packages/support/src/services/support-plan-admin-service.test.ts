/**
 * SupportPlanAdminService tests: the `support.manage-plans` permission split
 * gates every commercial-terms write (Managed Support Plans and Support
 * Compensation Plans), with cross-tenant writes refused (codex review round
 * 2, PR #1943 — generated CRUD on both models is read-only).
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANAGE_PLANS_PERMISSION,
  supportPrincipalFromPermissions,
} from '../permissions.js';
import {
  PlanAdminDeniedError,
  SupportPlanAdminService,
} from './support-plan-admin-service.js';

const MODEL_NAMES = ['SupportPlan', 'SupportCompensationPlan'];

const manager = (tenantId?: string) =>
  supportPrincipalFromPermissions([MANAGE_PLANS_PERMISSION], {
    id: 'profile-ops',
    tenantId,
  });
const member = () =>
  supportPrincipalFromPermissions([], { id: 'profile-member' });

describe('SupportPlanAdminService', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let admin: SupportPlanAdminService;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    admin = await SupportPlanAdminService.create({ db: ctx.db });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('denies every plan write without the manage-plans split', async () => {
    await expect(
      admin.savePlan({
        principal: member(),
        fields: { planKey: 'gold', name: 'Gold' },
      }),
    ).rejects.toThrow(PlanAdminDeniedError);
    await expect(
      admin.saveCompensationPlan({
        principal: member(),
        fields: { name: 'Rates', hourlyRate: 45.0 },
      }),
    ).rejects.toThrow(PlanAdminDeniedError);
  });

  it('creates, updates, and archives plans for a holder of the split', async () => {
    const plan = await admin.savePlan({
      principal: manager(),
      fields: {
        planKey: 'gold',
        name: 'Gold',
        includedMinutes: 600,
        overageHourlyRate: 150.0,
      },
    });
    expect(plan.planKey).toBe('gold');

    const updated = await admin.updatePlan(plan.id ?? '', {
      principal: manager(),
      fields: { overageHourlyRate: 175.0 },
    });
    expect(updated.overageHourlyRate).toBe(175);

    const archived = await admin.archivePlan(plan.id ?? '', {
      principal: manager(),
    });
    expect(archived.status).toBe('archived');
  });

  it('manages compensation plans through the same gate', async () => {
    const comp = await admin.saveCompensationPlan({
      principal: manager(),
      fields: {
        name: 'Specialist rates',
        hourlyRate: 45.0,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    });
    expect(comp.hourlyRate).toBe(45);

    const archived = await admin.archiveCompensationPlan(comp.id ?? '', {
      principal: manager(),
    });
    expect(archived.status).toBe('archived');
  });

  it('refuses cross-tenant plan writes even for a holder', async () => {
    const plan = await admin.savePlan({
      principal: manager('tenant-a'),
      fields: { tenantId: 'tenant-a', planKey: 'a-plan', name: 'A' },
    });
    await expect(
      admin.updatePlan(plan.id ?? '', {
        principal: manager('tenant-b'),
        fields: { overageHourlyRate: 999.0 },
      }),
    ).rejects.toThrow(/tenant/);
    await expect(
      admin.savePlan({
        principal: manager('tenant-b'),
        fields: { tenantId: 'tenant-a', planKey: 'forged', name: 'F' },
      }),
    ).rejects.toThrow(/tenant/);
  });
});
