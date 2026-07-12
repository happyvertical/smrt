import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectAssistanceSupportAdapter } from './project-assistance-adapter.js';
import { SupportCaseService } from './support-case-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
];

describe('ProjectAssistanceSupportAdapter', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let adapter: ProjectAssistanceSupportAdapter;
  let service: SupportCaseService;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    service = await SupportCaseService.create({ db: ctx.db });
    adapter = new ProjectAssistanceSupportAdapter(service);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('creates or joins losslessly within one tenant without cross-tenant collisions', async () => {
    const input = {
      assistanceRequestId: 'request-1',
      tenantId: 'tenant-a',
      projectId: 'project-1',
      requesterId: 'requester-1',
      subject: 'Export failed',
      conversation: [{ body: 'The CSV export returns an error.' }],
      evidence: [{ url: 'https://evidence.invalid/screenshot' }],
      applicationContext: { route: '/invoices' },
    };
    const first = await adapter.openOrJoin(input);
    const retried = await adapter.openOrJoin(input);
    expect(retried.caseId).toBe(first.caseId);

    const secondTenant = await adapter.openOrJoin({
      ...input,
      tenantId: 'tenant-b',
    });
    expect(secondTenant.caseId).not.toBe(first.caseId);

    expect(await service.interactions.forCase(first.caseId)).toHaveLength(1);
    expect(
      await service.interactions.forCase(secondTenant.caseId),
    ).toHaveLength(1);

    const handoff = {
      tenantId: 'tenant-a',
      caseId: first.caseId,
      developmentRequestId: 'development-1',
    };
    await adapter.linkDelivery(handoff);
    await adapter.linkDelivery(handoff);
    expect(
      await service.workLinks.list({
        where: {
          tenantId: 'tenant-a',
          caseId: first.caseId,
          targetType: '@happyvertical/smrt-projects:DevelopmentRequest',
          targetId: 'development-1',
        },
      }),
    ).toHaveLength(1);
    expect(
      (await service.events.forCase(first.caseId)).filter(
        (event) => event.eventType === 'work_linked',
      ),
    ).toHaveLength(1);
  });
});
