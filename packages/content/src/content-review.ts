import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ContentReviewFinding,
  ContentReviewKind,
  ContentReviewStatus,
} from './content-governance';

export interface ContentReviewOptions extends SmrtObjectOptions {
  contentId?: string;
  contentVersionId?: string;
  kind?: ContentReviewKind;
  policyKey?: string;
  status?: ContentReviewStatus;
  summary?: string;
  findings?: string | ContentReviewFinding[];
  reviewer?: string;
  metadata?: string | Record<string, unknown>;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_reviews',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class ContentReview extends SmrtObject {
  @foreignKey('Content', { required: true })
  contentId = '';

  @foreignKey('ContentVersion')
  contentVersionId = '';
  kind: ContentReviewKind = 'custom';
  policyKey = '';
  status: ContentReviewStatus = 'pending';
  summary = '';
  findings = '[]';
  reviewer = 'system';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentReviewOptions = {}) {
    super(options);
    if (options.contentId) this.contentId = options.contentId;
    if (options.contentVersionId !== undefined)
      this.contentVersionId = options.contentVersionId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.policyKey !== undefined) this.policyKey = options.policyKey;
    if (options.status !== undefined) this.status = options.status;
    if (options.summary !== undefined) this.summary = options.summary;
    if (options.reviewer !== undefined) this.reviewer = options.reviewer;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;

    if (options.findings !== undefined) {
      this.findings =
        typeof options.findings === 'string'
          ? options.findings
          : JSON.stringify(options.findings);
    }

    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getFindings(): ContentReviewFinding[] {
    if (Array.isArray(this.findings)) {
      return this.findings as ContentReviewFinding[];
    }

    try {
      return this.findings ? JSON.parse(this.findings) : [];
    } catch {
      return [];
    }
  }

  getMetadata(): Record<string, unknown> {
    if (this.metadata && typeof this.metadata === 'object') {
      return { ...(this.metadata as Record<string, unknown>) };
    }

    try {
      return this.metadata ? JSON.parse(this.metadata) : {};
    } catch {
      return {};
    }
  }
}
