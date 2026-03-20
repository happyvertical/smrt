import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentContributionRevision } from './content-contribution-revision';

export class ContentContributionRevisionCollection extends SmrtCollection<ContentContributionRevision> {
  static readonly _itemClass = ContentContributionRevision;

  async listForContribution(
    contributionId: string,
  ): Promise<ContentContributionRevision[]> {
    return this.list({
      where: { contributionId },
      orderBy: 'revision_number ASC',
    });
  }

  async getLatestForContribution(
    contributionId: string,
  ): Promise<ContentContributionRevision | null> {
    const revisions = await this.list({
      where: { contributionId },
      orderBy: 'revision_number DESC',
      limit: 1,
    });

    return revisions[0] || null;
  }
}
