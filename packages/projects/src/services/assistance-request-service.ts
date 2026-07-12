import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests.js';
import {
  type AssistanceRequest,
  AssistanceRequestCollection,
  AssistanceRequestEventCollection,
} from '../models/delivery-control-plane.js';
import type { ProjectIntegration } from '../models/ProjectIntegration.js';
import type {
  AssistanceClassification,
  DevelopmentRequestEvidence,
  ManagedAssistanceRequestInput,
} from '../types.js';
import { requireIntegrationCapability } from './delivery-service.js';

export interface AssistanceSupportPort {
  openOrJoin(input: {
    assistanceRequestId: string;
    tenantId: string;
    projectId: string;
    requesterId: string;
    subject: string;
    conversation: Record<string, unknown>[];
    evidence: DevelopmentRequestEvidence[];
    applicationContext: Record<string, unknown>;
  }): Promise<{ caseId: string }>;
  /** Implementations must treat this handoff as idempotent. */
  linkDelivery?(input: {
    tenantId: string;
    caseId: string;
    developmentRequestId: string;
  }): Promise<void>;
}

export class AssistanceRequestService {
  constructor(
    private readonly development: DevelopmentRequestCollection,
    private readonly requests: AssistanceRequestCollection,
    private readonly events: AssistanceRequestEventCollection,
    private readonly support?: AssistanceSupportPort,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
    dependencies: { support?: AssistanceSupportPort } = {},
  ): Promise<AssistanceRequestService> {
    const [development, requests, events] = await Promise.all([
      DevelopmentRequestCollection.create(options),
      AssistanceRequestCollection.create(options),
      AssistanceRequestEventCollection.create(options),
    ]);
    return new AssistanceRequestService(
      development,
      requests,
      events,
      dependencies.support,
    );
  }

  async createRequest(
    integration: ProjectIntegration,
    input: ManagedAssistanceRequestInput,
  ): Promise<AssistanceRequest> {
    requireIntegrationCapability(integration, 'assistance:create');
    if (!input.requesterId.trim())
      throw new Error('Assistance Request requires a stable requesterId.');
    if (!input.subject.trim())
      throw new Error('Assistance Request subject is required.');
    const request = await withTenant({ tenantId: integration.tenantId }, () =>
      this.requests.create({
        tenantId: integration.tenantId,
        integrationId: requiredId(integration.id, 'Project Integration'),
        requesterId: input.requesterId,
        subject: input.subject.trim(),
        applicationContext: JSON.stringify(input.applicationContext ?? {}),
        conversation: JSON.stringify(input.conversation ?? []),
        evidence: JSON.stringify(input.evidence ?? []),
        classification: 'unclassified',
        createdAt: new Date(),
      }),
    );
    await withTenant({ tenantId: integration.tenantId }, () => request.save());
    return request;
  }

  async classify(
    integration: ProjectIntegration,
    request: AssistanceRequest,
    input: {
      classification: Exclude<AssistanceClassification, 'unclassified'>;
      actorRef: string;
      reason: string;
      developmentType?: string;
    },
  ): Promise<AssistanceRequest> {
    requireIntegrationCapability(integration, 'assistance:create');
    if (
      request.integrationId !== integration.id ||
      request.tenantId !== integration.tenantId
    )
      throw new Error(
        'Assistance Request is outside this Project Integration.',
      );
    if (!input.reason.trim())
      throw new Error('Classification reason is required.');
    const prior = request.classification;

    if (
      (input.classification === 'support' || input.classification === 'both') &&
      !request.supportCaseId
    ) {
      if (!this.support)
        throw new Error('Support routing port is not configured.');
      const result = await this.support.openOrJoin({
        assistanceRequestId: requiredId(request.id, 'Assistance Request'),
        tenantId: request.tenantId,
        projectId: integration.projectId,
        requesterId: request.requesterId,
        subject: request.subject,
        conversation: parseArray(request.conversation),
        evidence: parseEvidence(request.evidence),
        applicationContext: parseObject(request.applicationContext),
      });
      request.supportCaseId = result.caseId;
    }

    if (
      (input.classification === 'development' ||
        input.classification === 'both') &&
      !request.developmentRequestId
    ) {
      const developmentRequest = await this.development.createManaged({
        tenantId: integration.tenantId,
        projectId: integration.projectId,
        integrationId: requiredId(integration.id, 'Project Integration'),
        requesterId: request.requesterId,
        type: input.developmentType ?? 'task',
        description: conversationText(request.conversation) || request.subject,
        evidence: parseEvidence(request.evidence),
        origin: `assistance:${request.id}`,
        discussion: input.reason,
        visibility: 'requester',
      });
      request.developmentRequestId = developmentRequest.id ?? '';
    }

    if (
      request.supportCaseId &&
      request.developmentRequestId &&
      !request.deliveryHandoffLinkedAt &&
      this.support?.linkDelivery
    ) {
      await this.support.linkDelivery({
        tenantId: request.tenantId,
        caseId: request.supportCaseId,
        developmentRequestId: request.developmentRequestId,
      });
      request.deliveryHandoffLinkedAt = new Date();
    }

    request.classification = input.classification;
    await withTenant({ tenantId: request.tenantId }, () => request.save());
    const event = await withTenant({ tenantId: request.tenantId }, () =>
      this.events.create({
        tenantId: request.tenantId,
        assistanceRequestId: requiredId(request.id, 'Assistance Request'),
        priorClassification: prior,
        resultingClassification: input.classification,
        actorRef: input.actorRef,
        reason: input.reason,
        resultingLinks: JSON.stringify({
          supportCaseId: request.supportCaseId || null,
          developmentRequestId: request.developmentRequestId || null,
        }),
        occurredAt: new Date(),
      }),
    );
    await withTenant({ tenantId: request.tenantId }, () => event.save());
    return request;
  }
}

function parseArray(value: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object' && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseEvidence(value: string): DevelopmentRequestEvidence[] {
  return parseArray(value)
    .map((item) => ({
      url: typeof item.url === 'string' ? item.url : '',
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
    }))
    .filter((item) => item.url.length > 0);
}

function conversationText(value: string): string {
  return parseArray(value)
    .map((message) => String(message.body ?? message.text ?? ''))
    .filter(Boolean)
    .join('\n\n');
}

function requiredId(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`${label} must be saved.`);
  return value;
}
