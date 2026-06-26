import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ContentContributionChannel } from './content-contribution-config';

export interface ContentContributionRevisionOptions extends SmrtObjectOptions {
  contributionId?: string;
  revisionNumber?: number;
  channel?: ContentContributionChannel;
  title?: string;
  description?: string | null;
  body?: string | null;
  sourceMessageId?: string | null;
  sourceThreadKey?: string | null;
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
  tableName: 'content_contribution_revisions',
  conflictColumns: ['contribution_id', 'revision_number'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class ContentContributionRevision extends SmrtObject {
  @foreignKey('ContentContribution', { required: true })
  contributionId = '';

  revisionNumber = 1;
  channel: ContentContributionChannel = 'web';
  title = '';
  description = '';
  body = '';

  @crossPackageRef('@happyvertical/smrt-messages:Message')
  sourceMessageId = '';

  sourceThreadKey = '';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentContributionRevisionOptions = {}) {
    super(options);
    if (options.contributionId !== undefined)
      this.contributionId = options.contributionId;
    if (options.revisionNumber !== undefined)
      this.revisionNumber = options.revisionNumber;
    if (options.channel !== undefined) this.channel = options.channel;
    if (options.title !== undefined) this.title = options.title;
    if (options.description !== undefined)
      this.description = options.description || '';
    if (options.body !== undefined) this.body = options.body || '';
    if (options.sourceMessageId !== undefined)
      this.sourceMessageId = options.sourceMessageId || '';
    if (options.sourceThreadKey !== undefined)
      this.sourceThreadKey = options.sourceThreadKey || '';
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
      sourceMessageId: this.sourceMessageId || null,
      sourceThreadKey: this.sourceThreadKey || null,
      metadata: this.getMetadata(),
    };
  }
}
