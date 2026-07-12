import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests.js';
import { ProjectIntegrationCollection } from '../collections/ProjectIntegrations.js';
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
import { requireActiveIntegrationCapability } from './delivery-service.js';

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
    private readonly integrations: ProjectIntegrationCollection,
    private readonly development: DevelopmentRequestCollection,
    private readonly requests: AssistanceRequestCollection,
    private readonly events: AssistanceRequestEventCollection,
    private readonly support?: AssistanceSupportPort,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
    dependencies: { support?: AssistanceSupportPort } = {},
  ): Promise<AssistanceRequestService> {
    const integrations = await ProjectIntegrationCollection.create(options);
    const sharedOptions = { ...options, db: integrations.db };
    const [development, requests, events] = await Promise.all([
      DevelopmentRequestCollection.create(sharedOptions),
      AssistanceRequestCollection.create(sharedOptions),
      AssistanceRequestEventCollection.create(sharedOptions),
    ]);
    return new AssistanceRequestService(
      integrations,
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
    const active = await requireActiveIntegrationCapability(
      this.integrations,
      integration,
      'assistance:create',
    );
    if (!input.requesterId.trim())
      throw new Error('Assistance Request requires a stable requesterId.');
    if (!input.subject.trim())
      throw new Error('Assistance Request subject is required.');
    const request = await withTenant({ tenantId: active.tenantId }, () =>
      this.requests.create({
        tenantId: active.tenantId,
        integrationId: requiredId(active.id, 'Project Integration'),
        requesterId: input.requesterId,
        subject: input.subject.trim(),
        applicationContext: JSON.stringify(input.applicationContext ?? {}),
        conversation: JSON.stringify(input.conversation ?? []),
        evidence: JSON.stringify(input.evidence ?? []),
        classification: 'unclassified',
        createdAt: new Date(),
      }),
    );
    await withTenant({ tenantId: active.tenantId }, () => request.save());
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
    const active = await requireActiveIntegrationCapability(
      this.integrations,
      integration,
      'assistance:create',
    );
    if (
      request.integrationId !== active.id ||
      request.tenantId !== active.tenantId
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
        projectId: active.projectId,
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
      const integrationId = requiredId(active.id, 'Project Integration');
      const origin = `assistance:${requiredId(request.id, 'Assistance Request')}`;
      const existing = (
        await withTenant({ tenantId: active.tenantId }, () =>
          this.development.list({
            where: {
              tenantId: active.tenantId,
              projectId: active.projectId,
              integrationId,
              origin,
            },
            orderBy: 'createdAt ASC',
            limit: 1,
          }),
        )
      )[0];
      const developmentRequest =
        existing ??
        (await this.development.createManaged({
          tenantId: active.tenantId,
          projectId: active.projectId,
          integrationId,
          requesterId: request.requesterId,
          type: input.developmentType ?? 'task',
          description:
            conversationText(request.conversation) || request.subject,
          evidence: parseEvidence(request.evidence),
          origin,
          discussion: input.reason,
          visibility: 'requester',
        }));
      request.developmentRequestId = developmentRequest.id ?? '';
    }

    if (
      input.classification === 'both' &&
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
