import { SmrtCollection } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { DevelopmentRequest } from '../models/DevelopmentRequest';
import type {
  DevelopmentRequestStatus,
  DevelopmentRequestTransitionInput,
  ManagedDevelopmentRequestCreateInput,
} from '../types';
import { DevelopmentRequestHistoryCollection } from './DevelopmentRequestHistories';

export class DevelopmentRequestCollection extends SmrtCollection<DevelopmentRequest> {
  static readonly _itemClass = DevelopmentRequest;

  async createManaged(
    input: {
      tenantId: string;
      projectId: string;
      integrationId: string;
    } & ManagedDevelopmentRequestCreateInput,
  ): Promise<DevelopmentRequest> {
    const request = await withTenant({ tenantId: input.tenantId }, () =>
      this.create({
        tenantId: input.tenantId,
        projectId: input.projectId,
        integrationId: input.integrationId,
        requesterId: input.requesterId,
        participantId: input.participantId ?? '',
        type: input.type,
        description: input.description,
        evidence: JSON.stringify(input.evidence ?? []),
        visibility: input.visibility ?? 'requester',
        origin: input.origin ?? 'managed-app',
        discussion: input.discussion ?? '',
        status: 'submitted',
      }),
    );
    await withTenant({ tenantId: input.tenantId }, () => request.save());
    await this.recordHistory(request, {
      status: 'submitted',
      actorType: 'integration',
      actorId: input.integrationId,
      note: input.discussion ?? '',
    });
    return request;
  }

  async listByIntegrationRequester(input: {
    tenantId: string;
    integrationId: string;
    requesterId: string;
  }): Promise<DevelopmentRequest[]> {
    return withTenant({ tenantId: input.tenantId }, () =>
      this.list({
        where: {
          tenantId: input.tenantId,
          integrationId: input.integrationId,
          requesterId: input.requesterId,
        },
        orderBy: 'createdAt ASC',
      }),
    );
  }

  async transitionStatus(
    tenantId: string,
    requestId: string,
    transition: DevelopmentRequestTransitionInput,
  ): Promise<DevelopmentRequest> {
    const request = await withTenant({ tenantId }, () =>
      this.findOne({ where: { id: requestId, tenantId } }),
    );
    if (!request) {
      throw new Error(`DevelopmentRequest ${requestId} not found`);
    }
    const fromStatus = request.status;
    request.status = transition.status;
    await withTenant({ tenantId: request.tenantId }, () => request.save());
    await this.recordHistory(request, transition, fromStatus);
    return request;
  }

  async listForProject(
    tenantId: string,
    projectId: string,
    status?: DevelopmentRequestStatus,
  ): Promise<DevelopmentRequest[]> {
    return withTenant({ tenantId }, () =>
      this.list({
        where: status
          ? { tenantId, projectId, status }
          : { tenantId, projectId },
        orderBy: 'createdAt ASC',
      }),
    );
  }

  private async recordHistory(
    request: DevelopmentRequest,
    transition: DevelopmentRequestTransitionInput,
    fromStatus = '',
  ): Promise<void> {
    const histories = await DevelopmentRequestHistoryCollection.create(
      this.options,
    );
    const entry = await withTenant({ tenantId: request.tenantId }, () =>
      histories.create({
        tenantId: request.tenantId,
        requestId: request.id as string,
        fromStatus,
        toStatus: transition.status,
        actorType: transition.actorType,
        actorId: transition.actorId ?? '',
        note: transition.note ?? '',
      }),
    );
    await withTenant({ tenantId: request.tenantId }, () => entry.save());
  }
}
