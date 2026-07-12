import { getTestDatabase } from '@happyvertical/smrt-core';
import { PricingRuleCollection } from '@happyvertical/smrt-subscriptions';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevelopmentRequestHistoryCollection } from '../collections/DevelopmentRequestHistories.js';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests.js';
import { ProjectIntegrationCollection } from '../collections/ProjectIntegrations.js';
import {
  PreviewApprovalCollection,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
} from '../models/index.js';
import { AssistanceRequestService } from '../services/assistance-request-service.js';
import { ProjectDeliveryService } from '../services/delivery-service.js';
import {
  DevelopmentRequestService,
  type DevelopmentWorkAdapter,
} from '../services/development-request-service.js';
import { ServiceEvidenceService } from '../services/service-evidence-service.js';
import { SubscriptionServiceCommercialResolver } from '../services/subscription-commercial-resolver.js';

describe('managed application delivery control plane (#1949)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function integration(capabilities: string[]) {
    const integrations = await ProjectIntegrationCollection.create({ db });
    return (
      await integrations.provision({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        name: 'Managed application',
        capabilities,
      })
    ).integration;
  }

  async function request(
    projectIntegrationId: string,
    input: {
      requesterId?: string;
      visibility?: 'requester' | 'workspace';
    } = {},
  ) {
    const requests = await DevelopmentRequestCollection.create({ db });
    return requests.createManaged({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      integrationId: projectIntegrationId,
      requesterId: input.requesterId ?? 'user-1',
      type: 'feature',
      description: 'Add a CSV export.',
      visibility: input.visibility ?? 'requester',
    });
  }

  it('triages idempotently into canonical work and filters board visibility', async () => {
    const work: DevelopmentWorkAdapter = {
      createWorkItem: vi.fn(async () => ({
        type: 'Issue',
        id: 'issue-42',
        canonicalStatus: 'Backlog',
        providerRef: 'provider-private',
      })),
      getWorkItem: vi.fn(async () => ({
        type: 'Issue',
        id: 'issue-42',
        canonicalStatus: 'Completed',
      })),
    };
    const projectIntegration = await integration(['delivery:read']);
    const developmentRequest = await request(projectIntegration.id as string, {
      requesterId: 'user-7',
      visibility: 'workspace',
    });
    const service = await DevelopmentRequestService.create({ db }, work);
    const accepted = await service.triage(developmentRequest, {
      decision: 'accept',
      reason: 'Fits roadmap',
      actorRef: 'operator',
    });
    const retried = await service.triage(developmentRequest, {
      decision: 'accept',
      reason: 'Retry',
      actorRef: 'operator',
    });
    expect(work.createWorkItem).toHaveBeenCalledTimes(1);
    expect(retried.links[0].id).toBe(accepted.links[0].id);
    expect(await service.syncWorkStatus(accepted.links[0])).toMatchObject({
      status: 'completed',
    });
    expect(
      await service.visibleFor({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        roles: ['workspace'],
      }),
    ).toHaveLength(1);
    expect(
      await service.visibleFor({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        requesterId: 'someone-else',
      }),
    ).toHaveLength(0);
  });

  it('audits decline, merge, and lossless split decisions', async () => {
    const projectIntegration = await integration(['delivery:read']);
    const service = await DevelopmentRequestService.create({ db });
    const declined = await request(projectIntegration.id as string);
    await service.triage(declined, {
      decision: 'decline',
      reason: 'Outside the product scope',
      actorRef: 'operator:1',
    });
    expect(declined.status).toBe('declined');

    const target = await request(projectIntegration.id as string);
    const merged = await request(projectIntegration.id as string);
    const mergeResult = await service.triage(merged, {
      decision: 'merge',
      mergeIntoRequestId: target.id as string,
      reason: 'Same desired outcome',
      actorRef: 'operator:1',
    });
    expect(mergeResult.links[0]).toMatchObject({
      workItemType: '@happyvertical/smrt-projects:DevelopmentRequest',
      workItemId: target.id,
      canonicalStatus: 'merged',
    });

    const source = await request(projectIntegration.id as string);
    source.setEvidence([{ url: 'https://evidence.invalid/original' }]);
    await source.save();
    const splitResult = await service.triage(source, {
      decision: 'split',
      reason: 'Separate client and data exports',
      actorRef: 'operator:1',
      split: [
        { type: 'feature', description: 'Export client records' },
        { type: 'task', description: 'Export data records' },
      ],
    });
    expect(splitResult.splitRequests).toHaveLength(2);
    expect(splitResult.splitRequests[0]).toMatchObject({
      requesterId: source.requesterId,
      origin: `split:${source.id}`,
      discussion: 'Separate client and data exports',
    });
    expect(splitResult.splitRequests[0].getEvidence()).toEqual(
      source.getEvidence(),
    );

    const histories = await DevelopmentRequestHistoryCollection.create({ db });
    const audited = await withTenant({ tenantId: 'tenant-1' }, () =>
      histories.list({
        where: { requestId: declined.id },
        orderBy: 'createdAt ASC',
      }),
    );
    expect(audited.at(-1)).toMatchObject({
      toStatus: 'declined',
      actorId: 'operator:1',
      note: 'Outside the product scope',
    });
  });

  it('deduplicates delivery events and sends preview decisions through the adapter', async () => {
    const requestApproval = vi.fn(async () => undefined);
    const work = {
      createWorkItem: vi.fn(),
      getWorkItem: vi.fn(),
      requestApproval,
    } as unknown as DevelopmentWorkAdapter;
    const projectIntegration = await integration([
      'delivery:write',
      'delivery:read',
      'previews:approve',
    ]);
    const developmentRequest = await request(projectIntegration.id as string);
    const delivery = await ProjectDeliveryService.create(
      { db },
      { workAdapter: work, approvalPolicy: { canApprove: async () => true } },
    );
    const first = await delivery.record({
      integration: projectIntegration,
      requestId: developmentRequest.id as string,
      idempotencyKey: 'preview-1',
      sequence: 4,
      type: 'preview',
      payload: { previewId: 'pv-1', previewUrl: 'https://preview.invalid' },
    });
    expect(
      (
        await delivery.record({
          integration: projectIntegration,
          requestId: developmentRequest.id as string,
          idempotencyKey: 'preview-1',
          sequence: 4,
          type: 'preview',
          payload: {},
        })
      ).id,
    ).toBe(first.id);
    const preview = (
      await withTenant({ tenantId: 'tenant-1' }, async () =>
        (await PreviewApprovalCollection.create({ db })).list(),
      )
    )[0];
    await delivery.decidePreview(projectIntegration, preview, {
      approved: true,
      actorRef: 'requester:user-1',
      reason: 'Verified',
    });
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it('retries failed delivery, replays in order, and rejects stale previews', async () => {
    const projectIntegration = await integration([
      'delivery:write',
      'delivery:read',
      'previews:approve',
    ]);
    const developmentRequest = await request(projectIntegration.id as string);
    const delivery = await ProjectDeliveryService.create(
      { db },
      {
        workAdapter: {
          createWorkItem: vi.fn(),
          getWorkItem: vi.fn(),
          requestApproval: vi.fn(),
        } as unknown as DevelopmentWorkAdapter,
      },
    );
    await delivery.record({
      integration: projectIntegration,
      requestId: developmentRequest.id as string,
      idempotencyKey: 'branch-1',
      sequence: 2,
      type: 'branch',
      payload: { name: 'codex/export' },
    });
    await delivery.record({
      integration: projectIntegration,
      requestId: developmentRequest.id as string,
      idempotencyKey: 'preview-2',
      sequence: 3,
      type: 'preview',
      payload: { previewId: 'pv-stale' },
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue(undefined);
    await delivery.deliverPending({ send }, 'tenant-1');
    await delivery.deliverPending({ send }, 'tenant-1');
    const events = await delivery.listForIntegration(
      projectIntegration,
      developmentRequest.id as string,
    );
    expect(events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(events[0]).toMatchObject({
      deliveryAttempts: 2,
      lastDeliveryError: '',
    });
    const replayed: number[] = [];
    await delivery.replay(
      { send: async (event) => void replayed.push(event.sequence) },
      projectIntegration,
      1,
    );
    expect(replayed).toEqual([2, 3]);

    const preview = (
      await withTenant({ tenantId: 'tenant-1' }, async () =>
        (await PreviewApprovalCollection.create({ db })).list(),
      )
    )[0];
    await delivery.markPreviewStale(preview);
    await expect(
      delivery.decidePreview(projectIntegration, preview, {
        approved: true,
        actorRef: 'requester:user-1',
        reason: 'Too late',
      }),
    ).rejects.toThrow(/stale/i);
  });

  it('shares immutable service evidence with separate commercial snapshots', async () => {
    const service = await ServiceEvidenceService.create(
      { db },
      {
        priceClient: async () => ({
          amount: 150,
          version: 'pricing-v2',
          strategy: 'fixed_unit',
          terms: { hourlyRate: 150 },
        }),
        compensateProvider: async () => ({
          amount: 90,
          version: 'terms-v4',
          terms: { hourlyRate: 90 },
        }),
      },
    );
    const entry = await service.record({
      workRefType: '@happyvertical/smrt-projects:DevelopmentRequest',
      workRefId: 'request-1',
      participantKind: 'agent',
      agentRef: 'agent:builder',
      source: 'agent',
      description: 'Implemented request',
      durationSeconds: 3600,
      evidence: [{ kind: 'pull_request', ref: 'pr:42' }],
    });
    await service.submit(entry);
    await service.approve(entry, { approvalPath: 'automatic' });
    const charges = await (
      await ServiceChargeSnapshotCollection.create({ db })
    ).list();
    const compensation = await (
      await ServiceCompensationSnapshotCollection.create({ db })
    ).list();
    expect(charges[0].amount - compensation[0].amount).toBe(60);
    await service.approve(entry, { approvalPath: 'retry' });
    expect(
      await (await ServiceChargeSnapshotCollection.create({ db })).list(),
    ).toHaveLength(1);
    charges[0].amount = 1;
    await expect(charges[0].save()).rejects.toThrow(/immutable/i);
    compensation[0].amount = 1;
    await expect(compensation[0].save()).rejects.toThrow(/immutable/i);
    entry.durationSeconds = 1;
    await expect(entry.save()).rejects.toThrow(/immutable/i);
  });

  it('prices approved service evidence through #1925 Client Charges', async () => {
    const rules = await PricingRuleCollection.create({ db });
    const rule = await withTenant({ tenantId: 'tenant-1' }, () =>
      rules.create({
        tenantId: 'tenant-1',
        ruleKey: 'services-v1',
        serviceKey: 'professional-services',
        metricKey: 'duration.seconds',
        strategy: 'fixed_unit',
        currency: 'USD',
        effectiveFrom: new Date('2026-01-01'),
      }),
    );
    rule.setTerms({ unitPrice: 0.02 });
    await withTenant({ tenantId: 'tenant-1' }, () => rule.save());
    const commercial = await SubscriptionServiceCommercialResolver.create(
      { db },
      {
        compensate: async () => ({
          amount: 25,
          version: 'provider-v1',
          terms: { fixed: true },
        }),
      },
    );
    const service = await ServiceEvidenceService.create({ db }, commercial);
    const entry = await service.record({
      tenantId: 'tenant-1',
      workRefType: '@happyvertical/smrt-projects:DevelopmentRequest',
      workRefId: 'request-2',
      participantKind: 'human',
      participantProfileId: 'profile-1',
      source: 'manual',
      description: 'Planning',
      durationSeconds: 1800,
      metadata: { projectId: 'project-1' },
    });
    await service.submit(entry);
    await service.approve(entry, { approvalPath: 'operator' });
    const charge = (
      await (await ServiceChargeSnapshotCollection.create({ db })).list()
    )[0];
    expect(charge).toMatchObject({ amount: 36, pricingVersion: 'services-v1' });
    expect(charge.sourceChargeRef).toContain(
      '@happyvertical/smrt-subscriptions:ClientCharge:',
    );
  });

  it('routes Assistance Requests to support, development, or both idempotently', async () => {
    const projectIntegration = await integration(['assistance:create']);
    const openOrJoin = vi.fn(
      async ({ assistanceRequestId }: { assistanceRequestId: string }) => ({
        caseId: `case:${assistanceRequestId}`,
      }),
    );
    const linkDelivery = vi.fn(async () => undefined);
    const assistance = await AssistanceRequestService.create(
      { db },
      { support: { openOrJoin, linkDelivery } },
    );
    const supportOnly = await assistance.createRequest(projectIntegration, {
      requesterId: 'user-1',
      subject: 'How do I export?',
      conversation: [{ body: 'Where is export?' }],
    });
    await assistance.classify(projectIntegration, supportOnly, {
      classification: 'support',
      actorRef: 'agent:triage',
      reason: 'Answerable question',
    });
    expect(supportOnly.supportCaseId).toContain('case:');
    const developmentOnly = await assistance.createRequest(projectIntegration, {
      requesterId: 'user-1',
      subject: 'Add PDF export',
      conversation: [{ body: 'Please add PDF.' }],
    });
    await assistance.classify(projectIntegration, developmentOnly, {
      classification: 'development',
      developmentType: 'feature',
      actorRef: 'agent:triage',
      reason: 'Desired change',
    });
    expect(developmentOnly.developmentRequestId).toBeTruthy();
    const both = await assistance.createRequest(projectIntegration, {
      requesterId: 'user-1',
      subject: 'CSV export crashes',
      conversation: [{ body: 'I get a 500.' }],
    });
    await assistance.classify(projectIntegration, both, {
      classification: 'both',
      developmentType: 'bug',
      actorRef: 'agent:triage',
      reason: 'Support communication plus delivery',
    });
    expect(both).toMatchObject({ classification: 'both' });
    expect(linkDelivery).toHaveBeenCalledOnce();
    await assistance.classify(projectIntegration, both, {
      classification: 'both',
      developmentType: 'bug',
      actorRef: 'operator',
      reason: 'Idempotent confirmation',
    });
    expect(openOrJoin).toHaveBeenCalledTimes(2);
  });
});
