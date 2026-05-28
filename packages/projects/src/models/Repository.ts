/**
 * Repository model - SMRT wrapper for repository operations
 *
 * Provides persistent repository tracking with provider-agnostic operations.
 * Uses @happyvertical/repos SDK for actual API calls.
 */

import { getRepository } from '@happyvertical/repos';
import { getModuleConfig } from '@happyvertical/smrt-config';
import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { SYNC_THROTTLE_MS } from '../constants';
import type {
  CreateIssueInput,
  CreatePRInput,
  IRepository,
  RepositoryProviderType,
  SDKRepository,
  SearchFilters,
  SyncOptions,
} from '../types';
import type { Issue } from './Issue';
import type { PullRequest } from './PullRequest';

export interface RepositoryOptions extends SmrtObjectOptions {
  owner?: string;
  name?: string;
  fullName?: string;
  description?: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  providerType?: RepositoryProviderType;
  baseUrl?: string;
  tokenConfigKey?: string;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'sync'] },
  // sync is an operator command invoked in-process via the CLI;
  // it intentionally isn't exposed over HTTP today.
  cli: { include: ['list', 'get', 'sync', 'create'], skipApiCheck: true },
})
export class Repository extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Repository owner (organization or user)
   */
  owner: string = '';

  /**
   * Repository name
   */
  name: string = '';

  /**
   * Full name in owner/repo format
   */
  fullName: string = '';

  /**
   * Repository description
   */
  description: string = '';

  /**
   * Default branch name
   */
  defaultBranch: string = 'main';

  /**
   * Whether repository is private
   */
  isPrivate: boolean = false;

  /**
   * Repository provider type
   */
  providerType: RepositoryProviderType = 'github';

  /**
   * Base URL for self-hosted instances (GitHub Enterprise, GitLab self-hosted, etc.)
   */
  baseUrl: string = '';

  /**
   * Environment variable name or config key for token resolution
   * The token is NOT stored - only the key name is persisted
   */
  tokenConfigKey: string = 'GITHUB_TOKEN';

  /**
   * Last sync timestamp
   */
  lastSyncedAt: Date | null = null;

  /**
   * Transient: Cached repository client (not persisted)
   */
  private _client?: IRepository;

  constructor(options: RepositoryOptions = {}) {
    super(options);
    if (options.owner !== undefined) this.owner = options.owner;
    if (options.name !== undefined) this.name = options.name;
    if (options.fullName !== undefined) this.fullName = options.fullName;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.defaultBranch !== undefined)
      this.defaultBranch = options.defaultBranch;
    if (options.isPrivate !== undefined) this.isPrivate = options.isPrivate;
    if (options.providerType !== undefined)
      this.providerType = options.providerType;
    if (options.baseUrl !== undefined) this.baseUrl = options.baseUrl;
    if (options.tokenConfigKey !== undefined)
      this.tokenConfigKey = options.tokenConfigKey;
    if (options.tenantId !== undefined)
      (this as any).tenantId = options.tenantId;
  }

  /**
   * Get the repository client, resolving token from config
   *
   * Token resolution order:
   * 1. Environment variable matching tokenConfigKey
   * 2. Module config value matching tokenConfigKey
   *
   * @returns Repository client for API operations
   * @throws Error if token cannot be resolved
   */
  async getClient(): Promise<IRepository> {
    if (this._client) {
      return this._client;
    }

    // Resolve token from environment or config
    const token =
      process.env[this.tokenConfigKey] ||
      (getModuleConfig<Record<string, string>>('smrt-projects', {})[
        this.tokenConfigKey
      ] as string);

    if (!token) {
      throw new Error(
        `Token not found for key '${this.tokenConfigKey}'. ` +
          `Set the ${this.tokenConfigKey} environment variable or configure it in smrt.config.`,
      );
    }

    this._client = await getRepository({
      type: this.providerType,
      owner: this.owner,
      repo: this.name,
      token,
      baseUrl: this.baseUrl || undefined,
    });

    return this._client;
  }

  /**
   * Clear the cached client (useful after token refresh)
   */
  clearClient(): void {
    this._client = undefined;
  }

  /**
   * Sync repository metadata from the provider
   *
   * @param options - Sync options
   * @returns This repository with updated fields
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
    const repoData: SDKRepository = await client.getRepository();

    // Update fields from remote
    this.owner = repoData.owner;
    this.name = repoData.name;
    this.fullName = `${repoData.owner}/${repoData.name}`;
    this.description = repoData.description;
    this.defaultBranch = repoData.defaultBranch;
    this.isPrivate = repoData.isPrivate;
    this.lastSyncedAt = new Date();

    await this.save();
    return this;
  }

  /**
   * Get issues from this repository
   *
   * @param filters - Optional search filters
   * @returns Array of Issue objects (SMRT models)
   */
  async getIssues(filters?: SearchFilters): Promise<Issue[]> {
    const { IssueCollection } = await import('../collections/Issues');
    const collection = await (IssueCollection as any).create(this.options);
    return await collection.discover({ repository: this, filters });
  }

  /**
   * Get pull requests from this repository
   *
   * @param filters - Optional search filters
   * @returns Array of PullRequest objects (SMRT models)
   */
  async getPullRequests(filters?: SearchFilters): Promise<PullRequest[]> {
    const { PullRequestCollection } = await import(
      '../collections/PullRequests'
    );
    const collection = await (PullRequestCollection as any).create(
      this.options,
    );
    return await collection.discover({ repository: this, filters });
  }

  /**
   * Create a new issue in this repository
   *
   * @param data - Issue creation data
   * @returns Created Issue (SMRT model)
   */
  async createIssue(data: CreateIssueInput): Promise<Issue> {
    const repositoryId = this.id ?? undefined;
    if (!repositoryId) {
      throw new Error('Repository must be saved before creating issues');
    }

    const client = await this.getClient();
    const created = await client.createIssue(data);

    // Create SMRT Issue from remote data
    const { Issue } = await import('./Issue');
    const issue = new Issue({
      ...this.options,
      repositoryId,
      number: created.number,
      nodeId: created.id,
      title: created.title,
      body: created.body,
      state: created.state,
      author: created.author.login,
      labels: created.labels.map((l) => l.name),
      assignees: created.assignees.map((a) => a.login),
      commentsCount: created.commentsCount,
      lastSyncedAt: new Date(),
    });

    await issue.save();
    return issue;
  }

  /**
   * Create a new pull request in this repository
   *
   * @param data - PR creation data
   * @returns Created PullRequest (SMRT model)
   */
  async createPullRequest(data: CreatePRInput): Promise<PullRequest> {
    const repositoryId = this.id ?? undefined;
    if (!repositoryId) {
      throw new Error('Repository must be saved before creating pull requests');
    }

    const client = await this.getClient();
    const created = await client.createPullRequest(data);

    // Create SMRT PullRequest from remote data
    const { PullRequest } = await import('./PullRequest');
    const pr = new PullRequest({
      ...this.options,
      repositoryId,
      number: created.number,
      nodeId: created.id,
      title: created.title,
      body: created.body,
      state: created.state,
      author: created.author.login,
      labels: created.labels.map((l) => l.name),
      assignees: created.assignees.map((a) => a.login),
      commentsCount: created.commentsCount,
      headRef: created.headRef,
      baseRef: created.baseRef,
      merged: created.merged,
      draft: created.draft,
      lastSyncedAt: new Date(),
    });

    await pr.save();
    return pr;
  }

  /**
   * Check if this repository has any open issues matching criteria
   *
   * @param criteria - Natural language description of what to check
   * @returns True if matching issues exist
   */
  async hasOpenIssuesMatching(criteria: string): Promise<boolean> {
    const issues = await this.getIssues({ state: 'open' });
    if (issues.length === 0) return false;

    return await this.is(
      `This repository has open issues matching: ${criteria}. ` +
        `Current open issues: ${issues.map((i) => `#${i.number}: ${i.title}`).join(', ')}`,
    );
  }

  /**
   * Generate a summary of repository activity
   *
   * @returns AI-generated summary
   */
  async summarizeActivity(): Promise<string> {
    const issues = await this.getIssues({ state: 'open', limit: 10 });
    const prs = await this.getPullRequests({ state: 'open', limit: 10 });

    return await this.do(
      `Summarize the current activity in this repository. ` +
        `Open issues: ${issues.map((i) => `#${i.number}: ${i.title}`).join(', ')}. ` +
        `Open PRs: ${prs.map((p) => `#${p.number}: ${p.title}`).join(', ')}.`,
    );
  }

  /**
   * Get repository by owner and name
   *
   * @param owner - Repository owner
   * @param name - Repository name
   * @param options - Additional options
   * @returns Repository or null if not found
   */
  static async getByFullName(
    owner: string,
    name: string,
    options: SmrtObjectOptions = {},
  ): Promise<Repository | null> {
    const { RepositoryCollection } = await import(
      '../collections/Repositories'
    );
    const collection = await (RepositoryCollection as any).create(options);
    return await collection.findByFullName(owner, name);
  }
}
