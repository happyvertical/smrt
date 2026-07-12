import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { AssistanceSupportPort } from '@happyvertical/smrt-projects';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { SupportCaseService } from './support-case-service.js';

/** Concrete lossless bridge from smrt-projects Assistance Requests to Support. */
export class ProjectAssistanceSupportAdapter implements AssistanceSupportPort {
  constructor(private readonly cases: SupportCaseService) {}

  static async create(
    options: SmrtObjectOptions,
  ): Promise<ProjectAssistanceSupportAdapter> {
    return new ProjectAssistanceSupportAdapter(
      await SupportCaseService.create(options),
    );
  }

  async openOrJoin(
    input: Parameters<AssistanceSupportPort['openOrJoin']>[0],
  ): Promise<{ caseId: string }> {
    const intakeKey = `assistance:${input.tenantId}:${input.assistanceRequestId}`;
    const threadKey = intakeKey;
    let supportCase = (
      await withTenant({ tenantId: input.tenantId }, () =>
        this.cases.cases.list({
          where: { tenantId: input.tenantId, threadKey },
          limit: 1,
        }),
      )
    )[0];
    if (!supportCase) {
      supportCase = await this.cases.openCase({
        tenantId: input.tenantId,
        subject: input.subject,
        description: input.conversation
          .map((message) => String(message.body ?? message.text ?? ''))
          .filter(Boolean)
          .join('\n\n'),
        channelKind: 'chat',
        projectId: input.projectId,
        threadKey,
        metadata: {
          assistanceRequestId: input.assistanceRequestId,
          requesterId: input.requesterId,
          applicationContext: input.applicationContext,
          evidence: input.evidence,
        },
      });
    }
    if (!supportCase.id) throw new Error('Support Case was not persisted.');
    for (const [index, message] of input.conversation.entries()) {
      const body = String(message.body ?? message.text ?? '');
      if (!body) continue;
      await this.cases.recordInteraction(supportCase, {
        direction: 'inbound',
        channelKind: 'chat',
        actorKind: 'client',
        body,
        sourceType: '@happyvertical/smrt-projects:AssistanceRequest',
        sourceId: input.assistanceRequestId,
        sourceKey: `${intakeKey}:${index}`,
        metadata: { preserved: true },
      });
    }
    return { caseId: supportCase.id };
  }

  async linkDelivery(
    input: Parameters<NonNullable<AssistanceSupportPort['linkDelivery']>>[0],
  ): Promise<void> {
    await withTenant({ tenantId: input.tenantId }, async () => {
      const existing = (
        await this.cases.workLinks.list({
          where: {
            tenantId: input.tenantId,
            caseId: input.caseId,
            targetType: '@happyvertical/smrt-projects:DevelopmentRequest',
            targetId: input.developmentRequestId,
          },
          limit: 1,
        })
      )[0];
      if (existing) return;
      await this.cases.linkWork(input.caseId, {
        actorKind: 'system',
        linkKind: 'development_work_item',
        targetType: '@happyvertical/smrt-projects:DevelopmentRequest',
        targetId: input.developmentRequestId,
        targetLabel: `Development Request ${input.developmentRequestId}`,
        metadata: { source: 'assistance_request' },
      });
    });
  }
}
