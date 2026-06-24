/**
 * Issue model - SMRT wrapper for issue tracking
 *
 * Provides persistent issue tracking with AI-powered feedback incorporation.
 * Uses @happyvertical/repos SDK for actual API calls.
 */

import { type AIClientOptions, getAI } from '@happyvertical/ai';
import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
  config as smrtConfig,
} from '@happyvertical/smrt-core';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { loadEnvConfig } from '@happyvertical/utils';
import { SYNC_THROTTLE_MS } from '../constants';
import { issueIncorporateFeedbackPrompt } from '../prompts';
import type {
  IncorporateFeedbackOptions,
  IncorporateFeedbackResult,
  IRepository,
  SDKComment,
  SyncOptions,
} from '../types';
import type { Comment } from './Comment';
import type { Repository } from './Repository';

/**
 * Resolved AI configuration produced by {@link loadEnvConfig} for the
 * `incorporateFeedback` synthesis path. Mirrors the schema passed to
 * `loadEnvConfig` (provider/model/apiKey plus tuning knobs).
 */
interface ResolvedAiConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
}

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
  // sync/incorporateFeedback/rollback are operator commands invoked in-process
  // via the CLI; they intentionally aren't exposed over HTTP today.
  cli: {
    include: ['list', 'get', 'sync', 'incorporateFeedback', 'rollback'],
    skipApiCheck: true,
  },
})
export class Issue extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

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
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
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
    const collection = await RepositoryCollection.create(this.options);
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

    const resolvedPrompt = await resolvePrompt(
      issueIncorporateFeedbackPrompt.key,
      {
        db: this.options.db ?? this.options.persistence,
        tenantId: this.tenantId,
        variables: {
          body: this.body,
          comments: relevantComments
            .map((c) => `- ${c.author}: ${c.body}`)
            .join('\n'),
        },
        override: options.prompt ? { template: options.prompt } : undefined,
      },
    );

    const aiOptions = {
      ...resolvedPrompt.ai.params,
      ...(resolvedPrompt.ai.model ? { model: resolvedPrompt.ai.model } : {}),
    };

    let synthesized: string;

    if (resolvedPrompt.ai.provider) {
      synthesized = await this.runPromptWithResolvedAI(
        resolvedPrompt.text,
        resolvedPrompt.ai.provider,
        aiOptions,
      );
    } else {
      // The resolved prompt template already curates the issue body + comments,
      // so opt out of do()'s object-data injection to avoid duplicating the body.
      synthesized = await this.do(resolvedPrompt.text, {
        ...aiOptions,
        includeData: false,
      });
    }

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

  private async runPromptWithResolvedAI(
    instructions: string,
    provider: string,
    options: Record<string, unknown>,
  ): Promise<string> {
    const aiOption = this.options.ai as Record<string, unknown> | undefined;
    if (this.isExplicitAiClientOption(aiOption)) {
      const ai = await this.getAiClient();
      return this.sendPromptMessage(ai, instructions, options);
    }

    const globalAiConfig = smrtConfig.toJSON().ai || {};
    const instanceAiConfig = aiOption ?? {};
    const aiConfig = loadEnvConfig<ResolvedAiConfig>(
      {
        ...globalAiConfig,
        ...instanceAiConfig,
      },
      {
        packageName: 'ai',
        prefix: 'SMRT',
        schema: {
          provider: 'string',
          model: 'string',
          apiKey: 'string',
          timeout: 'number',
          maxRetries: 'number',
          temperature: 'number',
          maxTokens: 'number',
        },
      },
    );

    const env = process.env;
    const apiKey =
      aiConfig.apiKey ||
      (provider === 'anthropic'
        ? env.ANTHROPIC_API_KEY
        : provider === 'gemini'
          ? env.GEMINI_API_KEY
          : env.OPENAI_API_KEY);

    const ai = await getAI({
      ...aiConfig,
      provider,
      type: provider,
      model: options.model ?? aiConfig.model,
      defaultModel: options.model ?? aiConfig.model,
      apiKey,
    } as AIClientOptions);

    return this.sendPromptMessage(ai, instructions, options);
  }

  /**
   * Sends a fully-resolved instruction string to the given AI client.
   *
   * `incorporateFeedback()` curates the entire prompt (issue body + comments)
   * via the resolved prompt template, so this path deliberately does NOT inject
   * the object's own field data — that would duplicate the body. The `this.do()`
   * fallback path passes `includeData: false` for the same reason, keeping both
   * `incorporateFeedback()` paths consistent (#1567).
   */
  private async sendPromptMessage(
    ai: {
      message: (
        prompt: string,
        options?: Record<string, unknown>,
      ) => Promise<string>;
    },
    instructions: string,
    options: Record<string, unknown>,
  ): Promise<string> {
    const prompt = `--- Beginning of instructions ---\n${instructions}\n--- End of instructions ---\nBased on the content body, please follow the instructions and provide a response. Never make use of codeblocks.`;
    const tools = this.getAvailableTools();

    return await ai.message(prompt, {
      ...options,
      tools: tools.length > 0 ? tools : undefined,
    });
  }

  private isExplicitAiClientOption(
    aiOption: Record<string, unknown> | undefined,
  ): boolean {
    return !!(
      aiOption &&
      typeof aiOption === 'object' &&
      typeof aiOption.embed === 'function' &&
      !aiOption.provider &&
      !aiOption.type
    );
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
