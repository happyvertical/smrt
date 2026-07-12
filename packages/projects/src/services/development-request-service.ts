import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests.js';
import type { DevelopmentRequest } from '../models/DevelopmentRequest.js';
import {
  type DevelopmentRequestWorkLink,
  DevelopmentRequestWorkLinkCollection,
} from '../models/delivery-control-plane.js';
import type { DevelopmentTriageDecision } from '../types.js';

export interface DevelopmentWorkItem {
  type: string;
  id: string;
  canonicalStatus: string;
  providerRef?: string;
  metadata?: Record<string, unknown>;
}

export interface DevelopmentWorkAdapter {
  createWorkItem(input: {
    request: DevelopmentRequest;
    idempotencyKey: string;
  }): Promise<DevelopmentWorkItem>;
  getWorkItem(link: DevelopmentRequestWorkLink): Promise<DevelopmentWorkItem>;
  requestApproval?(input: {
    request: DevelopmentRequest;
    previewId: string;
    approved: boolean;
    reason: string;
  }): Promise<void>;
}

export interface DevelopmentViewer {
  tenantId: string;
  projectId: string;
  requesterId?: string;
  roles?: Array<'workspace' | 'project_team' | 'internal'>;
}

export class DevelopmentRequestService {
  constructor(
    private readonly requests: DevelopmentRequestCollection,
    private readonly links: DevelopmentRequestWorkLinkCollection,
    readonly workAdapter?: DevelopmentWorkAdapter,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
    workAdapter?: DevelopmentWorkAdapter,
  ): Promise<DevelopmentRequestService> {
    return new DevelopmentRequestService(
      await DevelopmentRequestCollection.create(options),
      await DevelopmentRequestWorkLinkCollection.create(options),
      workAdapter,
    );
  }

  /** Visibility is evaluated after tenant and project scoping. */
  async visibleFor(viewer: DevelopmentViewer): Promise<DevelopmentRequest[]> {
    const all = await this.requests.listForProject(
      viewer.tenantId,
      viewer.projectId,
    );
    const roles = new Set(viewer.roles ?? []);
    return all.filter((request) => {
      if (roles.has('internal')) return true;
      if (request.requesterId === viewer.requesterId) return true;
      if (
        request.visibility === 'internal' ||
        request.visibility === 'requester'
      )
        return false;
      if (request.visibility === 'public') return true;
      if (roles.has('project_team'))
        return (
          request.visibility === 'workspace' ||
          request.visibility === 'project_team'
        );
      return roles.has('workspace') && request.visibility === 'workspace';
    });
  }

  async linksFor(
    request: DevelopmentRequest,
  ): Promise<DevelopmentRequestWorkLink[]> {
    return withTenant({ tenantId: request.tenantId }, () =>
      this.links.list({
        where: { requestId: request.id },
        orderBy: 'createdAt ASC',
      }),
    );
  }

  async triage(
    request: DevelopmentRequest,
    input: {
      decision: DevelopmentTriageDecision;
      reason: string;
      actorRef: string;
      mergeIntoRequestId?: string;
      split?: Array<{ description: string; type?: string }>;
    },
  ): Promise<{
    request: DevelopmentRequest;
    links: DevelopmentRequestWorkLink[];
    splitRequests: DevelopmentRequest[];
  }> {
    if (!input.reason.trim()) throw new Error('Triage reason is required.');
    requiredId(request.id, 'Development Request');
    const createdLinks: DevelopmentRequestWorkLink[] = [];
    const splitRequests: DevelopmentRequest[] = [];

    if (input.decision === 'accept') {
      const existing = await this.linksFor(request);
      if (existing.length > 0) createdLinks.push(...existing);
      else {
        if (!this.workAdapter)
          throw new Error(
            'DevelopmentWorkAdapter is required to accept requests.',
          );
        const work = await this.workAdapter.createWorkItem({
          request,
          idempotencyKey: `development-request:${request.id}`,
        });
        createdLinks.push(await this.linkWork(request, work));
      }
      if (request.status !== 'planned')
        await this.transition(request, 'planned', input.actorRef, input.reason);
    }

    if (input.decision === 'decline' && request.status !== 'declined')
      await this.transition(request, 'declined', input.actorRef, input.reason);

    if (input.decision === 'merge') {
      if (!input.mergeIntoRequestId)
        throw new Error('mergeIntoRequestId is required.');
      if (input.mergeIntoRequestId === request.id)
        throw new Error('A Development Request cannot be merged into itself.');
      const target = await withTenant({ tenantId: request.tenantId }, () =>
        this.requests.get({ id: input.mergeIntoRequestId }),
      );
      if (!target || target.projectId !== request.projectId)
        throw new Error(
          'Merge target must be a Development Request in the same project and tenant.',
        );
      createdLinks.push(
        await this.linkWork(request, {
          type: '@happyvertical/smrt-projects:DevelopmentRequest',
          id: input.mergeIntoRequestId,
          canonicalStatus: 'merged',
          metadata: { reason: input.reason },
        }),
      );
      if (request.status !== 'triaged')
        await this.transition(request, 'triaged', input.actorRef, input.reason);
    }

    if (input.decision === 'split') {
      if (!input.split?.length)
        throw new Error('At least one split request is required.');
      const origin = `split:${request.id}`;
      const unmatchedExisting = await withTenant(
        { tenantId: request.tenantId },
        () =>
          this.requests.list({
            where: {
              tenantId: request.tenantId,
              projectId: request.projectId,
              integrationId: request.integrationId,
              origin,
            },
            orderBy: 'createdAt ASC',
          }),
      );
      for (const part of input.split) {
        const description = part.description.trim();
        if (!description)
          throw new Error('Split request description is required.');
        const type = part.type ?? request.type;
        const existingIndex = unmatchedExisting.findIndex(
          (candidate) =>
            candidate.description.trim() === description &&
            candidate.type === type &&
            candidate.requesterId === request.requesterId &&
            candidate.participantId === request.participantId &&
            candidate.visibility === request.visibility,
        );
        if (existingIndex >= 0) {
          splitRequests.push(unmatchedExisting.splice(existingIndex, 1)[0]);
        } else {
          splitRequests.push(
            await this.requests.createManaged({
              tenantId: request.tenantId,
              projectId: request.projectId,
              integrationId: request.integrationId,
              requesterId: request.requesterId,
              participantId: request.participantId || undefined,
              type,
              description,
              evidence: request.getEvidence(),
              visibility: request.visibility,
              origin,
              discussion: input.reason,
            }),
          );
        }
      }
      if (request.status !== 'triaged')
        await this.transition(request, 'triaged', input.actorRef, input.reason);
    }

    return { request, links: createdLinks, splitRequests };
  }

  async syncWorkStatus(
    link: DevelopmentRequestWorkLink,
  ): Promise<DevelopmentRequest> {
    if (!this.workAdapter)
      throw new Error(
        'DevelopmentWorkAdapter is required to project board status.',
      );
    const work = await this.workAdapter.getWorkItem(link);
    link.canonicalStatus = work.canonicalStatus;
    link.metadata = JSON.stringify(work.metadata ?? {});
    link.lastProjectedAt = new Date();
    await withTenant({ tenantId: link.tenantId }, () => link.save());
    const request = await withTenant({ tenantId: link.tenantId }, () =>
      this.requests.get({ id: link.requestId }),
    );
    if (!request)
      throw new Error(`Development Request ${link.requestId} not found.`);
    const requestLinks = await this.linksFor(request);
    const completed = requestLinks.every((item) =>
      ['done', 'closed', 'completed', 'deployed'].includes(
        item.canonicalStatus.toLowerCase(),
      ),
    );
    const nextStatus = completed ? 'completed' : 'in_progress';
    if (request.status !== nextStatus)
      await this.transition(
        request,
        nextStatus,
        'system',
        `Canonical work status: ${work.canonicalStatus}`,
      );
    return request;
  }

  private async transition(
    request: DevelopmentRequest,
    status: 'triaged' | 'planned' | 'in_progress' | 'completed' | 'declined',
    actorRef: string,
    reason: string,
  ): Promise<void> {
    const updated = await this.requests.transitionStatus(
      request.tenantId,
      requiredId(request.id, 'Development Request'),
      { status, actorType: 'system', actorId: actorRef, note: reason },
    );
    request.status = updated.status;
  }

  private async linkWork(
    request: DevelopmentRequest,
    work: DevelopmentWorkItem,
  ): Promise<DevelopmentRequestWorkLink> {
    const existing = (
      await withTenant({ tenantId: request.tenantId }, () =>
        this.links.list({
          where: {
            requestId: request.id,
            workItemType: work.type,
            workItemId: work.id,
          },
          limit: 1,
        }),
      )
    )[0];
    if (existing) return existing;
    const link = await withTenant({ tenantId: request.tenantId }, () =>
      this.links.create({
        tenantId: request.tenantId,
        requestId: requiredId(request.id, 'Development Request'),
        workItemType: work.type,
        workItemId: work.id,
        canonicalStatus: work.canonicalStatus,
        providerRef: work.providerRef ?? '',
        metadata: JSON.stringify(work.metadata ?? {}),
        lastProjectedAt: new Date(),
      }),
    );
    await withTenant({ tenantId: request.tenantId }, () => link.save());
    return link;
  }
}

function requiredId(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`${label} must be saved.`);
  return value;
}
