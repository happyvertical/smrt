/**
 * Comment model - SMRT wrapper for issue/PR comments
 *
 * Represents a comment on an issue or pull request.
 */

import { createLogger } from '@happyvertical/logger';
import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

const logger = createLogger({ level: 'info' });

export interface CommentOptions extends SmrtObjectOptions {
  issueId?: string;
  commentId?: string;
  body?: string;
  author?: string;
  createdAt?: Date;
  updatedAt?: Date;
  url?: string;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class Comment extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Issue this comment belongs to
   */
  @foreignKey('Issue')
  issueId?: string;

  /**
   * Provider-specific comment ID
   */
  commentId: string = '';

  /**
   * Comment body text
   */
  body: string = '';

  /**
   * Comment author's login
   */
  author: string = '';

  /**
   * When the comment was created
   */
  createdAt: Date | null = null;

  /**
   * When the comment was last updated
   */
  updatedAt: Date | null = null;

  /**
   * Comment URL
   */
  url: string = '';

  constructor(options: CommentOptions = {}) {
    super(options);
    if (options.issueId !== undefined) this.issueId = options.issueId;
    if (options.commentId !== undefined) this.commentId = options.commentId;
    if (options.body !== undefined) this.body = options.body;
    if (options.author !== undefined) this.author = options.author;
    if (options.createdAt !== undefined) this.createdAt = options.createdAt;
    if (options.updatedAt !== undefined) this.updatedAt = options.updatedAt;
    if (options.url !== undefined) this.url = options.url;
    if (options.tenantId !== undefined)
      (this as any).tenantId = options.tenantId;
  }

  /**
   * AI-powered: Check if this comment contains a question
   */
  async isQuestion(): Promise<boolean> {
    return await this.is(
      'This comment contains a question or request for clarification',
    );
  }

  /**
   * AI-powered: Check if this comment contains approval
   */
  async isApproval(): Promise<boolean> {
    return await this.is(
      'This comment expresses approval, agreement, or a positive response (LGTM, +1, approved, etc.)',
    );
  }

  /**
   * AI-powered: Check if this comment requests changes
   */
  async requestsChanges(): Promise<boolean> {
    return await this.is(
      'This comment requests changes, modifications, or improvements to the issue/PR',
    );
  }

  /**
   * AI-powered: Extract action items from this comment
   *
   * @returns Array of action items
   */
  async extractActionItems(): Promise<string[]> {
    const result = await this.do(
      `Extract any action items, tasks, or requests from this comment.
      Return a JSON array of strings, each representing one action item.
      If no action items, return an empty array [].
      Only return the JSON array, nothing else.

      Comment: ${this.body}`,
      // Body is hand-rolled above; skip do()'s object-data injection (no dup).
      { includeData: false },
    );

    try {
      return JSON.parse(result);
    } catch (error) {
      logger.warn('Failed to parse action items JSON', {
        error: error instanceof Error ? error.message : error,
        response: result,
      });
      return [];
    }
  }

  /**
   * AI-powered: Summarize this comment
   *
   * @returns Brief summary
   */
  async summarize(): Promise<string> {
    return await this.do(
      `Summarize this comment in one sentence.
      Comment by ${this.author}: ${this.body}`,
      // Author + body hand-rolled above; skip do()'s object-data injection.
      { includeData: false },
    );
  }

  /**
   * Get the sentiment of this comment
   *
   * @returns Sentiment classification
   */
  async getSentiment(): Promise<'positive' | 'negative' | 'neutral'> {
    const result = await this.do(
      `Classify the sentiment of this comment as exactly one of: positive, negative, neutral
      Only return one word.
      Comment: ${this.body}`,
      // Body is hand-rolled above; skip do()'s object-data injection (no dup).
      { includeData: false },
    );

    const normalized = result.toLowerCase().trim();
    if (normalized.includes('positive')) return 'positive';
    if (normalized.includes('negative')) return 'negative';
    return 'neutral';
  }
}
