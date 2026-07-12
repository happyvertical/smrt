import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests.js';
import type { DevelopmentRequest } from '../models/DevelopmentRequest.js';
import {
  type PreviewApproval,
  PreviewApprovalCollection,
  type ProjectDeliveryEvent,
  ProjectDeliveryEventCollection,
  parseProjectJson,
} from '../models/delivery-control-plane.js';
import type { ProjectIntegration } from '../models/ProjectIntegration.js';
import type { DeliveryEventType } from '../types.js';
import type { DevelopmentWorkAdapter } from './development-request-service.js';

export interface DeliveryEventSender {
  send(event: ProjectDeliveryEvent): Promise<void>;
}

export interface ApprovalPolicy {
  canApprove(input: {
    integration: ProjectIntegration;
    requestId: string;
    previewId: string;
  }): Promise<boolean>;
}

export class ProjectDeliveryService {
  constructor(
    private readonly requests: DevelopmentRequestCollection,
    private readonly events: ProjectDeliveryEventCollection,
    private readonly approvals: PreviewApprovalCollection,
    private readonly workAdapter?: DevelopmentWorkAdapter,
    private readonly approvalPolicy?: ApprovalPolicy,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
    dependencies: {
      workAdapter?: DevelopmentWorkAdapter;
      approvalPolicy?: ApprovalPolicy;
    } = {},
  ): Promise<ProjectDeliveryService> {
    const [requests, events, approvals] = await Promise.all([
      DevelopmentRequestCollection.create(options),
      ProjectDeliveryEventCollection.create(options),
      PreviewApprovalCollection.create(options),
    ]);
    return new ProjectDeliveryService(
      requests,
      events,
      approvals,
      dependencies.workAdapter,
      dependencies.approvalPolicy,
    );
  }

  async record(input: {
    integration: ProjectIntegration;
    requestId: string;
    idempotencyKey: string;
    sequence: number;
    type: DeliveryEventType;
    payload: Record<string, unknown>;
    occurredAt?: Date;
  }): Promise<ProjectDeliveryEvent> {
    requireIntegrationCapability(input.integration, 'delivery:write');
    if (!input.idempotencyKey.trim())
      throw new Error('Delivery event idempotencyKey is required.');
    const existing = (
      await withTenant({ tenantId: input.integration.tenantId }, () =>
        this.events.list({
          where: {
            integrationId: input.integration.id,
            idempotencyKey: input.idempotencyKey,
          },
          limit: 1,
        }),
      )
    )[0];
    if (existing) {
      await this.applySideEffects(input.integration, existing);
      return existing;
    }
    const request = await this.requestForIntegration(
      input.integration,
      input.requestId,
    );
    const event = await withTenant(
      { tenantId: input.integration.tenantId },
      () =>
        this.events.create({
          tenantId: input.integration.tenantId,
          integrationId: requiredId(
            input.integration.id,
            'Project Integration',
          ),
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          sequence: input.sequence,
          type: input.type,
          payload: JSON.stringify(input.payload),
          occurredAt: input.occurredAt ?? new Date(),
        }),
    );
    await withTenant({ tenantId: input.integration.tenantId }, () =>
      event.save(),
    );
    await this.applySideEffects(input.integration, event, request);
    return event;
  }

  private async applySideEffects(
    integration: ProjectIntegration,
    event: ProjectDeliveryEvent,
    loadedRequest?: DevelopmentRequest,
  ): Promise<void> {
    const request =
      loadedRequest ??
      (await this.requestForIntegration(integration, event.requestId));
    const payload = parseProjectJson<Record<string, unknown>>(
      event.payload,
      {},
    );
    if (event.type === 'preview') await this.upsertPreview(request, payload);
    if (
      (event.type === 'completed' || event.type === 'deployment') &&
      request.status !== 'completed'
    )
      await this.requests.transitionStatus(request.tenantId, event.requestId, {
        status: 'completed',
        actorType: 'integration',
        actorId: integration.id ?? '',
        note: event.type,
      });
    if (event.type === 'rejected' && request.status !== 'declined')
      await this.requests.transitionStatus(request.tenantId, event.requestId, {
        status: 'declined',
        actorType: 'integration',
        actorId: integration.id ?? '',
        note: String(payload.reason ?? 'Delivery rejected'),
      });
  }

  async listForIntegration(
    integration: ProjectIntegration,
    requestId: string,
  ): Promise<ProjectDeliveryEvent[]> {
    requireIntegrationCapability(integration, 'delivery:read');
    await this.requestForIntegration(integration, requestId);
    return withTenant({ tenantId: integration.tenantId }, () =>
      this.events.list({
        where: { integrationId: integration.id, requestId },
        orderBy: 'sequence ASC',
      }),
    );
  }

  async deliverPending(
    sender: DeliveryEventSender,
    tenantId: string,
    integrationId?: string,
  ): Promise<void> {
    const pending = await withTenant({ tenantId }, () =>
      this.events.list({
        where: integrationId
          ? { integrationId, deliveredAt: null }
          : { deliveredAt: null },
        orderBy: 'sequence ASC',
      }),
    );
    for (const event of pending) {
      event.deliveryAttempts += 1;
      try {
        await sender.send(event);
        event.deliveredAt = new Date();
        event.lastDeliveryError = '';
      } catch (error) {
        event.lastDeliveryError =
          error instanceof Error ? error.message : String(error);
      }
      await withTenant({ tenantId }, () => event.save());
    }
  }

  async replay(
    sender: DeliveryEventSender,
    integration: ProjectIntegration,
    afterSequence = -1,
  ): Promise<void> {
    requireIntegrationCapability(integration, 'delivery:read');
    const events = (
      await withTenant({ tenantId: integration.tenantId }, () =>
        this.events.list({
          where: { integrationId: integration.id },
          orderBy: 'sequence ASC',
        }),
      )
    ).filter((event) => event.sequence > afterSequence);
    for (const event of events) await sender.send(event);
  }

  async decidePreview(
    integration: ProjectIntegration,
    preview: PreviewApproval,
    input: { approved: boolean; actorRef: string; reason: string },
  ): Promise<PreviewApproval> {
    requireIntegrationCapability(integration, 'previews:approve');
    if (preview.tenantId !== integration.tenantId)
      throw new Error('Preview is outside this Project Integration tenant.');
    if (preview.status === 'stale')
      throw new Error('Stale previews cannot be approved.');
    if (preview.status !== 'pending') return preview;
    const request = await this.requestForIntegration(
      integration,
      preview.requestId,
    );
    if (
      this.approvalPolicy &&
      !(await this.approvalPolicy.canApprove({
        integration,
        requestId: preview.requestId,
        previewId: preview.previewId,
      }))
    )
      throw new Error('Preview approval denied by policy.');
    if (!this.workAdapter?.requestApproval)
      throw new Error('Control-plane approval adapter is not configured.');
    await this.workAdapter.requestApproval({
      request,
      previewId: preview.previewId,
      idempotencyKey: `preview-approval:${requiredId(preview.id, 'Preview Approval')}`,
      approved: input.approved,
      reason: input.reason,
    });
    preview.status = input.approved ? 'approved' : 'rejected';
    preview.decidedByRef = input.actorRef;
    preview.reason = input.reason;
    preview.decidedAt = new Date();
    await withTenant({ tenantId: integration.tenantId }, () => preview.save());
    return preview;
  }

  async markPreviewStale(preview: PreviewApproval): Promise<PreviewApproval> {
    if (preview.status === 'pending') {
      preview.status = 'stale';
      preview.staleAt = new Date();
      await withTenant({ tenantId: preview.tenantId }, () => preview.save());
    }
    return preview;
  }

  private async requestForIntegration(
    integration: ProjectIntegration,
    requestId: string,
  ): Promise<DevelopmentRequest> {
    const request = await withTenant({ tenantId: integration.tenantId }, () =>
      this.requests.get({ id: requestId }),
    );
    if (
      !request ||
      request.integrationId !== integration.id ||
      request.projectId !== integration.projectId
    )
      throw new Error(
        'Development Request is outside this Project Integration.',
      );
    return request;
  }

  private async upsertPreview(
    request: DevelopmentRequest,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const previewId = String(payload.previewId ?? '');
    if (!previewId) return;
    const existing = (
      await withTenant({ tenantId: request.tenantId }, () =>
        this.approvals.list({
          where: { requestId: request.id, previewId },
          limit: 1,
        }),
      )
    )[0];
    if (existing) return;
    const approval = await withTenant({ tenantId: request.tenantId }, () =>
      this.approvals.create({
        tenantId: request.tenantId,
        requestId: requiredId(request.id, 'Development Request'),
        previewId,
        previewUrl: String(payload.previewUrl ?? ''),
        status: 'pending',
        createdAt: new Date(),
      }),
    );
    await withTenant({ tenantId: request.tenantId }, () => approval.save());
  }
}

export function requireIntegrationCapability(
  integration: ProjectIntegration,
  capability: string,
): void {
  if (!integration.isActive())
    throw new Error('Project Integration is revoked.');
  if (!integration.hasCapability(capability))
    throw new Error(`Project Integration lacks capability '${capability}'.`);
}

function requiredId(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`${label} must be saved.`);
  return value;
}
