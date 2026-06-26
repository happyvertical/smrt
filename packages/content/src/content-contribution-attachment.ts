import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ContentContributionChannel } from './content-contribution-config';

export interface ContentContributionAttachmentOptions
  extends SmrtObjectOptions {
  contributionId?: string;
  revisionId?: string | null;
  filename?: string;
  mimeType?: string;
  size?: number;
  fileKey?: string | null;
  sourceUri?: string | null;
  channel?: ContentContributionChannel;
  promotedAssetId?: string | null;
  metadata?: Record<string, unknown> | string;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  if (typeof raw === 'object') {
    return { ...(raw as Record<string, unknown>) };
  }

  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_contribution_attachments',
  conflictColumns: ['id'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class ContentContributionAttachment extends SmrtObject {
  @foreignKey('ContentContribution', { required: true })
  contributionId = '';

  @foreignKey('ContentContributionRevision')
  revisionId = '';

  filename = '';
  mimeType = '';
  size = 0;
  fileKey = '';
  sourceUri = '';
  channel: ContentContributionChannel = 'web';

  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  promotedAssetId = '';

  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentContributionAttachmentOptions = {}) {
    super(options);
    if (options.contributionId !== undefined)
      this.contributionId = options.contributionId;
    if (options.revisionId !== undefined)
      this.revisionId = options.revisionId || '';
    if (options.filename !== undefined) this.filename = options.filename;
    if (options.mimeType !== undefined) this.mimeType = options.mimeType;
    if (options.size !== undefined) this.size = options.size;
    if (options.fileKey !== undefined) this.fileKey = options.fileKey || '';
    if (options.sourceUri !== undefined)
      this.sourceUri = options.sourceUri || '';
    if (options.channel !== undefined) this.channel = options.channel;
    if (options.promotedAssetId !== undefined)
      this.promotedAssetId = options.promotedAssetId || '';
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getMetadata(): Record<string, unknown> {
    return parseMetadata(this.metadata);
  }

  protected override transformJSON(json: Record<string, unknown>) {
    return {
      ...json,
      revisionId: this.revisionId || null,
      fileKey: this.fileKey || null,
      sourceUri: this.sourceUri || null,
      promotedAssetId: this.promotedAssetId || null,
      metadata: this.getMetadata(),
    };
  }
}
