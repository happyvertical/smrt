import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentContributionAttachment } from './content-contribution-attachment';

export class ContentContributionAttachmentCollection extends SmrtCollection<ContentContributionAttachment> {
  static readonly _itemClass = ContentContributionAttachment;

  async listForContribution(
    contributionId: string,
  ): Promise<ContentContributionAttachment[]> {
    return this.list({
      where: { contributionId },
      orderBy: 'created_at ASC',
    });
  }

  async listForRevision(
    revisionId: string,
  ): Promise<ContentContributionAttachment[]> {
    return this.list({
      where: { revisionId },
      orderBy: 'created_at ASC',
    });
  }
}
