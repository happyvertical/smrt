/**
 * Repository model - SMRT wrapper for repository operations
 *
 * Provides persistent repository tracking with provider-agnostic operations.
 * Uses @happyvertical/repos SDK for actual API calls.
 */

import { getRepository } from '@happyvertical/repos';
import {
  ObjectRegistry,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
  toSnakeCase,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { SYNC_THROTTLE_MS } from '../constants';
import { getScopedRepositoryClient } from '../repository-client-scope';
import { resolveRepositoryToken } from '../repository-token';
import type {
  CreateIssueInput,
  CreatePRInput,
  IRepository,
  RepositoryCiState,
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
  url?: string;
  archived?: boolean;
  lastPushedAt?: Date | null;
  openPullRequestCount?: number;
  ciState?: RepositoryCiState;
  latestReleaseTag?: string;
  latestReleaseDate?: Date | null;
  latestReleaseUrl?: string;
  lastObservedAt?: Date | null;
  missingSince?: Date | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'sync'] },
  // sync is an operator command invoked in-process via the CLI;
  // it intentionally isn't exposed over HTTP today.
  cli: { include: ['list', 'get', 'sync', 'create'], skipApiCheck: true },
  // One record per (tenant, provider, owner, name). Independent of any
  // project: project links (smrt#4906) attach by id without touching this key.
  indexes: [
    {
      name: 'repositories_tenant_provider_owner_name_key',
      columns: ['tenantId', 'providerType', 'owner', 'name'],
      unique: true,
    },
  ],
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
   * Web URL of the repository on the provider (set by organization sync)
   */
  url: string = '';

  /**
   * Whether the provider reports the repository as archived. Consumers hide
   * archived repositories by default.
   */
  archived: boolean = false;

  /**
   * Time of the last push, or null when never pushed / not yet observed
   */
  lastPushedAt: Date | null = null;

  /**
   * Open pull request count at the last observation
   */
  openPullRequestCount: number = 0;

  /**
   * Rolled-up CI state of the default-branch head commit. 'unknown' until
   * the first organization sync observes the repository.
   */
  ciState: RepositoryCiState = 'unknown';

  /**
   * Tag of the latest release, or empty when the repository has none
   */
  latestReleaseTag: string = '';

  /**
   * Publication time of the latest release
   */
  latestReleaseDate: Date | null = null;

  /**
   * Web URL of the latest release, or empty
   */
  latestReleaseUrl: string = '';

  /**
   * Last time an organization sync saw this repository in the provider
   * listing. Drives the organization-sync throttle.
   */
  lastObservedAt: Date | null = null;

  /**
   * Set when an organization sync no longer lists the repository (deleted,
   * transferred, or access lost); cleared when it reappears. Rows are kept so
   * links and history survive.
   */
  missingSince: Date | null = null;

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
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.url !== undefined) this.url = options.url;
    if (options.archived !== undefined) this.archived = options.archived;
    if (options.lastPushedAt !== undefined)
      this.lastPushedAt = options.lastPushedAt;
    if (options.openPullRequestCount !== undefined)
      this.openPullRequestCount = options.openPullRequestCount;
    if (options.ciState !== undefined) this.ciState = options.ciState;
    if (options.latestReleaseTag !== undefined)
      this.latestReleaseTag = options.latestReleaseTag;
    if (options.latestReleaseDate !== undefined)
      this.latestReleaseDate = options.latestReleaseDate;
    if (options.latestReleaseUrl !== undefined)
      this.latestReleaseUrl = options.latestReleaseUrl;
    if (options.lastObservedAt !== undefined)
      this.lastObservedAt = options.lastObservedAt;
    if (options.missingSince !== undefined)
      this.missingSince = options.missingSince;
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
    const scopedClient = getScopedRepositoryClient(this);
    if (scopedClient) {
      return scopedClient;
    }
    if (this._client) {
      return this._client;
    }

    const token = resolveRepositoryToken(this.tokenConfigKey);

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
    const collection = await IssueCollection.create(this.options);
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
    const collection = await PullRequestCollection.create(this.options);
    return await collection.discover({ repository: this, filters });
  }

  /**
   * Options for an issue or pull request created from this repository: the
   * database connection and tenant context, without any of this repository's
   * own columns (identity, timestamps, data). A repository loaded from the database holds its row's
   * `id`/`slug` in `this.options`; spread into a new issue they would give
   * every issue the repository's primary key and slug, so each save would
   * overwrite the previous issue.
   */
  private childOptions(): Record<string, unknown> {
    const rest = { ...(this.options as Record<string, unknown>) };
    // Every column of the repository's own row goes, not just a known few: a
    // loaded repository's `created_at` (or any other field) would otherwise
    // be copied onto each new issue.
    const ownKeys = new Set([
      'id',
      'slug',
      'context',
      '_skipLoad',
      'created_at',
      'updated_at',
      'createdAt',
      'updatedAt',
    ]);
    for (const fieldName of ObjectRegistry.getFields(
      this.getResolvedQualifiedName(),
    ).keys()) {
      ownKeys.add(fieldName);
      ownKeys.add(toSnakeCase(fieldName));
    }
    // The tenant is context, not identity: issues belong to the
    // repository's tenant.
    ownKeys.delete('tenantId');
    ownKeys.delete('tenant_id');
    for (const key of ownKeys) delete rest[key];
    return rest;
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
    const issue = new (ObjectRegistry.resolveEffectiveConstructor(Issue))({
      ...this.childOptions(),
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

    // Directly-constructed models must be initialized before save() can access
    // the database connection (SmrtCollection.create() does this internally).
    await issue.initialize();
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
    const pr = new (ObjectRegistry.resolveEffectiveConstructor(PullRequest))({
      ...this.childOptions(),
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

    // Directly-constructed models must be initialized before save() can access
    // the database connection (SmrtCollection.create() does this internally).
    await pr.initialize();
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
    const collection = await RepositoryCollection.create(options);
    return await collection.findByFullName(owner, name);
  }
}
