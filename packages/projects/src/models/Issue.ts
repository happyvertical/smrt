/**
 * Issue model - SMRT wrapper for issue tracking
 *
 * Provides persistent issue tracking with AI-powered feedback incorporation.
 * Uses @happyvertical/repos SDK for actual API calls.
 */

import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { SYNC_THROTTLE_MS } from '../constants';
import type {
  IncorporateFeedbackOptions,
  IncorporateFeedbackResult,
  IRepository,
  SDKComment,
  SyncOptions,
} from '../types';
import type { Comment } from './Comment';
import type { Repository } from './Repository';

export interface IssueOptions extends SmrtObjectOptions {
  repositoryId?: string;
  number?: number;
  nodeId?: string;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  author?: string;
  labels?: string[];
  assignees?: string[];
  commentsCount?: number;
  lastSyncedAt?: Date | null;
  originalBody?: string;
  synthesisCount?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'sync', 'incorporateFeedback'] },
  cli: { include: ['list', 'get', 'sync', 'incorporateFeedback', 'rollback'] },
})
export class Issue extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId = tenantId({ nullable: true });

  /**
   * Repository this issue belongs to
   */
  @foreignKey('Repository', { required: true })
  repositoryId?: string;

  /**
   * Issue number (provider-specific)
   */
  number: number = 0;

  /**
   * Node ID for GraphQL operations (GitHub Projects API)
   */
  nodeId: string = '';

  /**
   * Issue title
   */
  title: string = '';

  /**
   * Issue body/description
   */
  body: string = '';

  /**
   * Issue state
   */
  state: 'open' | 'closed' = 'open';

  /**
   * Author's login/username
   */
  author: string = '';

  /**
   * Labels attached to the issue
   */
  labels: string[] = [];

  /**
   * Assignee logins
   */
  assignees: string[] = [];

  /**
   * Number of comments on the issue
   */
  commentsCount: number = 0;

  /**
   * Last sync timestamp
   */
  lastSyncedAt: Date | null = null;

  /**
   * Original body before any AI synthesis (for rollback)
   */
  originalBody: string = '';

  /**
   * Number of times feedback has been incorporated
   */
  synthesisCount: number = 0;

  /**
   * Transient: Cached repository (not persisted)
   * Protected so PullRequest can access it
   */
  protected _repository?: Repository;

  /**
   * Transient: Cached client (not persisted)
   */
  protected _client?: IRepository;

  constructor(options: IssueOptions = {}) {
    super(options);
    if (options.repositoryId !== undefined)
      this.repositoryId = options.repositoryId;
    if (options.number !== undefined) this.number = options.number;
    if (options.nodeId !== undefined) this.nodeId = options.nodeId;
    if (options.title !== undefined) this.title = options.title;
    if (options.body !== undefined) this.body = options.body;
    if (options.state !== undefined) this.state = options.state;
    if (options.author !== undefined) this.author = options.author;
    if (options.labels !== undefined) this.labels = options.labels;
    if (options.assignees !== undefined) this.assignees = options.assignees;
    if (options.commentsCount !== undefined)
      this.commentsCount = options.commentsCount;
    if (options.lastSyncedAt !== undefined)
      this.lastSyncedAt = options.lastSyncedAt;
    if (options.originalBody !== undefined)
      this.originalBody = options.originalBody;
    if (options.synthesisCount !== undefined)
      this.synthesisCount = options.synthesisCount;
    if (options.tenantId !== undefined)
      (this as any).tenantId = options.tenantId;
  }

  /**
   * Get the repository this issue belongs to
   */
  async getRepository(): Promise<Repository> {
    if (this._repository) {
      return this._repository;
    }

    if (!this.repositoryId) {
      throw new Error('Issue has no repositoryId set');
    }

    const { RepositoryCollection } = await import(
      '../collections/Repositories'
    );
    const collection = await (RepositoryCollection as any).create(this.options);
    const repo = await collection.get({ id: this.repositoryId });

    if (!repo) {
      throw new Error(`Repository ${this.repositoryId} not found`);
    }

    this._repository = repo;
    return repo;
  }

  /**
   * Get the repository client for API operations
   */
  async getClient(): Promise<IRepository> {
    if (this._client) {
      return this._client;
    }

    const repo = await this.getRepository();
    this._client = await repo.getClient();
    return this._client;
  }

  /**
   * Clear cached repository and client
   */
  clearCache(): void {
    this._repository = undefined;
    this._client = undefined;
  }

  /**
   * Sync issue data from the provider
   *
   * @param options - Sync options
   * @returns This issue with updated fields
   */
  async sync(options: SyncOptions = {}): Promise<this> {
    // Check if we recently synced (within 5 minutes)
    if (
      !options.force &&
      this.lastSyncedAt &&
      Date.now() - this.lastSyncedAt.getTime() < SYNC_THROTTLE_MS
    ) {
      return this;
    }

    const client = await this.getClient();
    const issueData = await client.getIssue(this.number);

    // Update fields from remote
    this.nodeId = issueData.id;
    this.title = issueData.title;
    this.body = issueData.body;
    this.state = issueData.state;
    this.author = issueData.author.login;
    this.labels = issueData.labels.map((l) => l.name);
    this.assignees = issueData.assignees.map((a) => a.login);
    this.commentsCount = issueData.commentsCount;
    this.lastSyncedAt = new Date();

    await this.save();
    return this;
  }

  /**
   * Get comments on this issue
   *
   * @returns Array of Comment objects (SMRT models)
   */
  async getComments(): Promise<Comment[]> {
    const client = await this.getClient();
    const comments: SDKComment[] = await client.listComments(this.number);

    const { Comment: CommentClass } = await import('./Comment');
    return comments.map(
      (c) =>
        new CommentClass({
          ...this.options,
          issueId: this.id ?? undefined,
          commentId: c.id,
          body: c.body,
          author: c.author.login,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          url: c.url,
        }),
    );
  }

  /**
   * Add a comment to this issue
   *
   * @param body - Comment body text
   * @returns Created Comment (SMRT model)
   */
  async addComment(body: string): Promise<Comment> {
    const client = await this.getClient();
    const created = await client.addComment(this.number, body);

    const { Comment: CommentClass } = await import('./Comment');
    const comment = new CommentClass({
      ...this.options,
      issueId: this.id ?? undefined,
      commentId: created.id,
      body: created.body,
      author: created.author.login,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      url: created.url,
    });

    await comment.save();
    this.commentsCount++;
    await this.save();

    return comment;
  }

  /**
   * Incorporate feedback from comments into the issue body
   *
   * This is the core "Living Spec" functionality:
   * 1. Reads all comments on the issue
   * 2. Uses AI to synthesize comments with the current body
   * 3. Optionally updates the issue with the synthesized content
   *
   * @param options - Feedback incorporation options
   * @returns Result with synthesized content and status
   */
  async incorporateFeedback(
    options: IncorporateFeedbackOptions = {},
  ): Promise<IncorporateFeedbackResult> {
    const comments = await this.getComments();

    // Filter comments by date if specified
    let relevantComments = comments;
    if (options.since) {
      const sinceDate = options.since;
      relevantComments = comments.filter(
        (c) => c.createdAt && c.createdAt > sinceDate,
      );
    }

    if (relevantComments.length === 0) {
      return {
        synthesized: this.body,
        applied: false,
        commentsAnalyzed: 0,
      };
    }

    // Build the synthesis prompt
    const defaultPrompt = `You are updating a specification document based on team feedback.

Current specification:
${this.body}

Team comments and feedback:
${relevantComments.map((c) => `- ${c.author}: ${c.body}`).join('\n')}

Instructions:
1. Analyze the comments for consensus, changes, and new requirements
2. Update the specification to reflect the agreed-upon changes
3. Maintain the original structure and formatting where possible
4. Mark any conflicting feedback that needs resolution
5. Return ONLY the updated specification text, no additional commentary`;

    const prompt = options.prompt || defaultPrompt;

    // Use AI to synthesize the feedback
    const synthesized = await this.do(prompt);

    const result: IncorporateFeedbackResult = {
      synthesized,
      applied: false,
      commentsAnalyzed: relevantComments.length,
      previousBody: this.body,
    };

    // Apply changes if requested
    if (options.apply) {
      // Store original for rollback (only if first synthesis)
      if (this.synthesisCount === 0) {
        this.originalBody = this.body;
      }

      // Update the issue body
      const client = await this.getClient();
      await client.updateIssue(this.number, { body: synthesized });

      // Update local state
      this.body = synthesized;
      this.synthesisCount++;
      this.lastSyncedAt = new Date();
      await this.save();

      result.applied = true;
    }

    return result;
  }

  /**
   * Rollback to the original body before AI synthesis
   *
   * @returns Result with success status
   */
  async rollback(): Promise<{ success: boolean; message: string }> {
    if (!this.originalBody) {
      return {
        success: false,
        message: 'No original body to rollback to',
      };
    }

    if (this.synthesisCount === 0) {
      return {
        success: false,
        message: 'No synthesis has been applied',
      };
    }

    // Update the issue body on the provider
    const client = await this.getClient();
    await client.updateIssue(this.number, { body: this.originalBody });

    // Update local state
    this.body = this.originalBody;
    this.originalBody = '';
    this.synthesisCount = 0;
    this.lastSyncedAt = new Date();
    await this.save();

    return {
      success: true,
      message: 'Successfully rolled back to original body',
    };
  }

  /**
   * AI-powered: Check if this issue needs review
   *
   * @returns True if the issue likely needs attention
   */
  async needsReview(): Promise<boolean> {
    return await this.is(
      `This issue needs review because one or more of the following:
      - It has been open for a long time without updates
      - There are unresolved questions in the comments
      - The requirements are unclear or incomplete
      - There is conflicting feedback that needs resolution`,
    );
  }

  /**
   * AI-powered: Check if the issue is a bug report
   */
  async isBugReport(): Promise<boolean> {
    return await this.is(
      'This issue describes a bug, defect, or unexpected behavior',
    );
  }

  /**
   * AI-powered: Check if the issue is a feature request
   */
  async isFeatureRequest(): Promise<boolean> {
    return await this.is(
      'This issue is a feature request or enhancement proposal',
    );
  }

  /**
   * AI-powered: Generate suggested labels based on content
   *
   * @returns Array of suggested label names
   */
  async suggestLabels(): Promise<string[]> {
    const suggestion = await this.do(
      `Based on the issue title and body, suggest appropriate labels.
      Consider:
      - Type: bug, feature, docs, chore, test
      - Priority: P0 (critical), P1 (high), P2 (medium), P3 (low)
      - Area: specific code areas or components

      Return only a comma-separated list of labels, nothing else.`,
    );

    return suggestion
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * Close this issue
   */
  async close(): Promise<void> {
    const client = await this.getClient();
    await client.closeIssue(this.number);
    this.state = 'closed';
    this.lastSyncedAt = new Date();
    await this.save();
  }

  /**
   * Add labels to this issue
   *
   * @param labels - Label names to add
   */
  async addLabels(labels: string[]): Promise<void> {
    const client = await this.getClient();
    await client.addLabels(this.number, labels);
    this.labels = [...new Set([...this.labels, ...labels])];
    await this.save();
  }

  /**
   * Remove a label from this issue
   *
   * @param label - Label name to remove
   */
  async removeLabel(label: string): Promise<void> {
    const client = await this.getClient();
    await client.removeLabel(this.number, label);
    this.labels = this.labels.filter((l) => l !== label);
    await this.save();
  }

  /**
   * Assign users to this issue
   *
   * @param assignees - User logins to assign
   */
  async assign(assignees: string[]): Promise<void> {
    const client = await this.getClient();
    await client.assignIssue(this.number, assignees);
    this.assignees = [...new Set([...this.assignees, ...assignees])];
    await this.save();
  }

  /**
   * Get issue URL
   */
  getUrl(): string {
    const repo = this._repository;
    if (repo) {
      return `https://github.com/${repo.owner}/${repo.name}/issues/${this.number}`;
    }
    return '';
  }
}
