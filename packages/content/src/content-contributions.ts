import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import {
  AttachmentCollection,
  type Email,
  EmailCollection,
} from '@happyvertical/smrt-messages';
import type { ContentContributionAttachmentInput } from './content-contribution';
import { ContentContribution } from './content-contribution';
import type { ContentContributionTypeDefinition } from './content-contribution-config';
import {
  evaluateContributionIntake,
  getContentContributionTypeConfigState,
  getEffectiveContentContributionConfig,
} from './content-contribution-config';
import { ContentContributorCollection } from './content-contributors';

export interface SubmitWebContentContributionOptions {
  typeKey: string;
  contributorEmail: string;
  contributorName?: string | null;
  title?: string | null;
  description?: string | null;
  body?: string | null;
  attachments?: ContentContributionAttachmentInput[];
  metadata?: Record<string, unknown>;
  tenantId?: string | null;
}

export interface IngestEmailContentContributionOptions {
  emailId: string;
  typeKey?: string | null;
  tenantId?: string | null;
}

function toContributionStatus(
  decision: ReturnType<typeof evaluateContributionIntake>['decision'],
) {
  if (decision === 'quarantined') {
    return 'quarantined' as const;
  }

  if (decision === 'rejected') {
    return 'rejected' as const;
  }

  return 'submitted' as const;
}

function pickDefaultEmailType(
  types: ContentContributionTypeDefinition[],
): ContentContributionTypeDefinition | null {
  const emailTypes = types.filter(
    (type) =>
      type.enabled !== false && (type.allowedChannels || []).includes('email'),
  );

  return emailTypes.length === 1 ? emailTypes[0] : null;
}

@smrt({
  api: {
    include: [
      'submitWebContribution',
      'ingestEmailContribution',
      'listForContributor',
      'listInboxAction',
      'getContributionTypesAction',
    ],
    routes: {
      submitWebContribution: {
        scope: 'collection',
        method: 'POST',
        path: 'submit',
      },
      ingestEmailContribution: {
        scope: 'collection',
        method: 'POST',
        path: 'ingest-email',
      },
      listForContributor: {
        scope: 'collection',
        method: 'GET',
        path: 'by-contributor',
      },
      listInboxAction: {
        scope: 'collection',
        method: 'GET',
        path: 'inbox',
      },
      getContributionTypesAction: {
        scope: 'collection',
        method: 'GET',
        path: 'types',
      },
    },
  },
  mcp: false,
  cli: false,
})
export class ContentContributions extends SmrtCollection<ContentContribution> {
  static readonly _itemClass = ContentContribution;

  private async getContributorCollection() {
    return ContentContributorCollection.create(this.options);
  }

  private async getEmailCollection() {
    return EmailCollection.create(this.options);
  }

  private async getAttachmentCollection() {
    return AttachmentCollection.create(this.options);
  }

  private async resolveSubmissionType(
    typeKey: string | null | undefined,
  ): Promise<ContentContributionTypeDefinition> {
    const effective = await getEffectiveContentContributionConfig({
      db: this.db,
    });

    if (typeKey) {
      const match = effective.types.find((type) => type.key === typeKey);
      if (match) {
        return match;
      }
      throw new Error(`Unknown contribution type "${typeKey}".`);
    }

    const defaultType = pickDefaultEmailType(effective.types);
    if (!defaultType) {
      throw new Error(
        'A contribution type key is required unless there is exactly one email-enabled type.',
      );
    }

    return defaultType;
  }

  async getContributionTypesAction() {
    return getContentContributionTypeConfigState({ db: this.db });
  }

  async listForContributor(
    options: { contributorId?: string; contributorEmail?: string } = {},
  ) {
    let contributorId = options.contributorId;

    if (!contributorId && options.contributorEmail) {
      const contributors = await this.getContributorCollection();
      const contributor = await contributors.getByEmail(
        options.contributorEmail,
      );
      contributorId = contributor?.id || undefined;
    }

    if (!contributorId) {
      return [];
    }

    return this.list({
      where: { contributorId },
      orderBy: 'updated_at DESC',
    });
  }

  async listInboxAction(
    options: { statuses?: string | string[] } = {},
  ): Promise<ContentContribution[]> {
    const requested = Array.isArray(options.statuses)
      ? options.statuses
      : typeof options.statuses === 'string'
        ? options.statuses.split(',').map((item) => item.trim())
        : ['submitted', 'quarantined', 'needs_changes', 'approved'];

    const contributions = await this.list({
      orderBy: 'updated_at DESC',
    });

    return contributions.filter((contribution) =>
      requested.includes(contribution.status),
    );
  }

  async submitWebContribution(options: SubmitWebContentContributionOptions) {
    const type = await this.resolveSubmissionType(options.typeKey);
    const contributors = await this.getContributorCollection();
    const contributor = await contributors.findOrCreateByEmail({
      email: options.contributorEmail,
      name: options.contributorName || null,
      tenantId: options.tenantId ?? null,
    });

    const intake = evaluateContributionIntake({
      contributionType: type,
      trustLevel: contributor.trustLevel,
      channel: 'web',
      title: options.title || null,
      description: options.description || null,
      body: options.body || null,
      attachments: options.attachments || [],
    });

    const status = toContributionStatus(intake.decision);

    const contribution = await this.create({
      contributorId: contributor.id || '',
      contributionTypeKey: type.key,
      status,
      intakeDecision: intake.decision,
      channel: 'web',
      title: options.title || '',
      description: options.description || '',
      body: options.body || '',
      contributorEmail: contributor.email,
      contributorName: contributor.name,
      editorNotes: intake.reasons.join('\n'),
      tenantId: options.tenantId ?? null,
      metadata: JSON.stringify({
        intake: {
          decision: intake.decision,
          reasons: intake.reasons,
        },
        submission: options.metadata || {},
      }),
    });
    await contribution.save();

    await contribution.appendRevisionAction({
      title: options.title,
      description: options.description,
      body: options.body,
      attachments: options.attachments || [],
      channel: 'web',
      metadata: {
        source: 'web',
      },
    });

    if (
      contributor.trustLevel === 'trusted' &&
      intake.decision === 'accepted' &&
      type.promotion?.autoPromoteTrusted === true
    ) {
      return contribution.approveAction({
        editorNote: 'Auto-promoted trusted contributor submission.',
        targetStatus: type.promotion?.targetContentStatus || 'draft',
      });
    }

    return {
      contribution: contribution.toJSON(),
      intake,
    };
  }

  async ingestEmailContribution(
    options: IngestEmailContentContributionOptions,
  ) {
    const emailCollection = await this.getEmailCollection();
    // EmailCollection.get() is typed as the Message base; the rows it returns
    // are Emails, so narrow to Email to read the email-specific fields below.
    const email = (await emailCollection.get({
      id: options.emailId,
    })) as Email | null;
    if (!email) {
      throw new Error(`Email "${options.emailId}" not found.`);
    }

    const type = await this.resolveSubmissionType(options.typeKey);
    const contributors = await this.getContributorCollection();
    const contributor = await contributors.findOrCreateByEmail({
      email: email.fromAddress,
      name: email.fromName || null,
      tenantId: options.tenantId ?? null,
    });

    const attachmentCollection = await this.getAttachmentCollection();
    const inboundAttachments = await attachmentCollection.getByMessage(
      email.id || '',
    );
    const normalizedAttachments: ContentContributionAttachmentInput[] =
      inboundAttachments
        .filter((attachment) => !attachment.isInline())
        .map((attachment) => ({
          filename: attachment.filename || 'attachment',
          mimeType: attachment.contentType || 'application/octet-stream',
          size: attachment.size || 0,
          sourceUri: attachment.filePath || attachment.sourceUrl || null,
          metadata: {
            messageId: email.id || null,
            attachmentId: attachment.id || null,
          },
        }));

    const threadKey =
      email.threadId || email.messageId || email.inReplyTo || email.id || '';

    const intake = evaluateContributionIntake({
      contributionType: type,
      trustLevel: contributor.trustLevel,
      channel: 'email',
      title: email.subject || null,
      body: email.textBody || email.body || null,
      attachments: normalizedAttachments,
    });

    const existing =
      threadKey &&
      (await this.get({
        threadKey,
        contributorId: contributor.id || '',
      }));

    if (existing) {
      existing.intakeDecision = intake.decision;
      existing.editorNotes = intake.reasons.join('\n');

      const metadata = existing.getMetadata();
      metadata.lastEmailIntake = {
        decision: intake.decision,
        reasons: intake.reasons,
        emailId: email.id || null,
      };
      existing.setMetadata(metadata);

      if (intake.decision === 'rejected') {
        existing.status = 'rejected';
        existing.rejectedAt = new Date();
        await existing.save();

        return {
          contribution: existing.toJSON(),
          intake,
          revision: null,
          attachments: (await existing.getAttachments()).map((item) =>
            item.toJSON(),
          ),
        };
      }

      existing.status = toContributionStatus(intake.decision);
      await existing.save();

      const appended = await existing.appendRevisionAction({
        title: email.subject || existing.title,
        body: email.textBody || email.body || '',
        channel: 'email',
        sourceMessageId: email.id || '',
        sourceThreadKey: threadKey,
        attachments: normalizedAttachments,
        metadata: {
          source: 'email-reply',
          emailId: email.id || null,
        },
      });

      return {
        ...appended,
        intake,
      };
    }

    const status = toContributionStatus(intake.decision);

    const contribution = await this.create({
      contributorId: contributor.id || '',
      contributionTypeKey: type.key,
      status,
      intakeDecision: intake.decision,
      channel: 'email',
      title: email.subject || '',
      description: '',
      body: email.textBody || email.body || '',
      contributorEmail: contributor.email,
      contributorName: contributor.name,
      threadKey,
      sourceMessageId: email.id || '',
      editorNotes: intake.reasons.join('\n'),
      tenantId: options.tenantId ?? null,
      metadata: JSON.stringify({
        intake: {
          decision: intake.decision,
          reasons: intake.reasons,
        },
        email: {
          emailId: email.id || null,
          messageId: email.messageId || null,
          inReplyTo: email.inReplyTo || null,
          threadId: email.threadId || null,
        },
      }),
    });
    await contribution.save();

    await contribution.appendRevisionAction({
      title: email.subject || '',
      body: email.textBody || email.body || '',
      channel: 'email',
      sourceMessageId: email.id || null,
      sourceThreadKey: threadKey,
      attachments: normalizedAttachments,
      metadata: {
        source: 'email',
        emailId: email.id || null,
      },
    });

    if (
      contributor.trustLevel === 'trusted' &&
      intake.decision === 'accepted' &&
      type.promotion?.autoPromoteTrusted === true
    ) {
      return contribution.approveAction({
        editorNote: 'Auto-promoted trusted contributor email submission.',
        targetStatus: type.promotion?.targetContentStatus || 'draft',
      });
    }

    return {
      contribution: contribution.toJSON(),
      intake,
    };
  }
}
