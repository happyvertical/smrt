import { SmrtCollection } from '@happyvertical/smrt-core';
import type {
  ContentReviewKind,
  ContentReviewResult,
} from './content-governance';
import { ContentReview } from './content-review';

export class ContentReviewCollection extends SmrtCollection<ContentReview> {
  static readonly _itemClass = ContentReview;

  async listForContent(
    contentId: string,
    kind?: ContentReviewKind,
  ): Promise<ContentReview[]> {
    return this.list({
      where: kind ? { contentId, kind } : { contentId },
      orderBy: 'created_at DESC',
    });
  }

  async getLatestForContent(
    contentId: string,
    kind?: ContentReviewKind,
  ): Promise<ContentReview | null> {
    const reviews = await this.listForContent(contentId, kind);
    return reviews[0] ?? null;
  }

  async listForContentByPolicyKey(
    contentId: string,
    policyKey: string,
  ): Promise<ContentReview[]> {
    return this.list({
      where: { contentId, policyKey },
      orderBy: 'created_at DESC',
    });
  }

  async getLatestForPolicyKey(
    contentId: string,
    policyKey: string,
  ): Promise<ContentReview | null> {
    const reviews = await this.listForContentByPolicyKey(contentId, policyKey);
    return reviews[0] ?? null;
  }

  async createFromResult(options: {
    contentId: string;
    contentVersionId?: string | null;
    kind: ContentReviewKind;
    policyKey: string;
    reviewer?: string;
    result: ContentReviewResult;
    metadata?: Record<string, any>;
    tenantId?: string | null;
  }): Promise<ContentReview> {
    return this.create({
      contentId: options.contentId,
      contentVersionId: options.contentVersionId || '',
      kind: options.kind,
      policyKey: options.policyKey,
      status: options.result.status,
      summary: options.result.summary,
      findings: JSON.stringify(options.result.findings),
      reviewer: options.reviewer || 'system',
      metadata: JSON.stringify(options.metadata || {}),
      tenantId: options.tenantId ?? null,
    });
  }
}
