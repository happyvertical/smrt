import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ContentContributionAttachment } from './content-contribution-attachment';

// The collection's own @smrt() surface: its read helpers are published
// operations (the API explorer and the workbench call them). A collection
// inherits only its model's CRUD verbs, so it lists the helpers it opens here.
// The CRUD verbs repeat the model's because a collection decorator's config
// is merged over its model's at runtime.
@smrt({
  // Mirror the model's storage so the collection decorator cannot plan a
  // different table or natural key for it.
  tableName: 'content_contribution_attachments',
  conflictColumns: ['id'],
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'listForContribution',
      'listForRevision',
    ],
  },
  mcp: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'listForContribution',
      'listForRevision',
    ],
  },
})
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
