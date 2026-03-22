/**
 * PullRequestCollection - Collection manager for PullRequest objects
 *
 * Provides querying and discovery operations for PullRequest entities.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { PullRequest } from '../models/PullRequest';
import type { Repository } from '../models/Repository';
import type { SDKPullRequest, SearchFilters } from '../types';

export class PullRequestCollection extends SmrtCollection<PullRequest> {
  static readonly _itemClass = PullRequest;

  /**
   * Discover pull requests from a repository and sync to database
   *
   * @param options - Discovery options
   * @returns Array of PullRequest objects
   */
  async discover(options: {
    repository: Repository;
    filters?: SearchFilters;
  }): Promise<PullRequest[]> {
    const { repository, filters } = options;
    const repositoryId = repository.id;

    if (!repositoryId) {
      throw new Error(
        'Repository must be saved before discovering pull requests',
      );
    }

    const repoClient = await repository.getClient();

    // Note: searchIssues with type filter would get PRs in GitHub
    // For now, we'll search for all and filter
    const remoteItems = await repoClient.searchIssues('is:pr', filters);

    const pullRequests: PullRequest[] = [];

    for (const remote of remoteItems) {
      // Get full PR data
      let prData: SDKPullRequest;
      try {
        prData = await repoClient.getPullRequest(remote.number);
      } catch (error) {
        // Log error and skip PR - could be rate limiting, auth, or access issues
        console.warn(
          `Failed to fetch PR #${remote.number} from ${repository.owner}/${repository.name}:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }

      // Find existing PR by repository + number
      let pr = await this.findOne({
        where: {
          repositoryId,
          number: remote.number,
        },
      });

      if (!pr) {
        // Create new PR
        pr = await this.create({
          repositoryId,
          number: prData.number,
          nodeId: prData.id,
          title: prData.title,
          body: prData.body,
          state: prData.state,
          author: prData.author.login,
          labels: prData.labels.map((l) => l.name),
          assignees: prData.assignees.map((a) => a.login),
          commentsCount: prData.commentsCount,
          headRef: prData.headRef,
          baseRef: prData.baseRef,
          merged: prData.merged,
          mergedAt: prData.mergedAt || null,
          mergeable: prData.mergeable,
          draft: prData.draft,
          lastSyncedAt: new Date(),
        });
      } else {
        // Update existing PR
        pr.nodeId = prData.id;
        pr.title = prData.title;
        pr.body = prData.body;
        pr.state = prData.state;
        pr.author = prData.author.login;
        pr.labels = prData.labels.map((l) => l.name);
        pr.assignees = prData.assignees.map((a) => a.login);
        pr.commentsCount = prData.commentsCount;
        pr.headRef = prData.headRef;
        pr.baseRef = prData.baseRef;
        pr.merged = prData.merged;
        pr.mergedAt = prData.mergedAt || null;
        pr.mergeable = prData.mergeable;
        pr.draft = prData.draft;
        pr.lastSyncedAt = new Date();
      }

      await pr.save();
      pullRequests.push(pr);
    }

    return pullRequests;
  }

  /**
   * Find PRs by repository
   *
   * @param repositoryId - Repository ID
   * @returns Array of PRs
   */
  async findByRepository(repositoryId: string): Promise<PullRequest[]> {
    return await this.list({
      where: { repositoryId },
    });
  }

  /**
   * Find open PRs
   *
   * @param repositoryId - Optional repository filter
   * @returns Array of open PRs
   */
  async findOpen(repositoryId?: string): Promise<PullRequest[]> {
    const where: Record<string, any> = { state: 'open' };
    if (repositoryId) {
      where.repositoryId = repositoryId;
    }
    return await this.list({ where });
  }

  /**
   * Find draft PRs
   *
   * @param repositoryId - Optional repository filter
   * @returns Array of draft PRs
   */
  async findDrafts(repositoryId?: string): Promise<PullRequest[]> {
    const openPRs = await this.findOpen(repositoryId);
    return openPRs.filter((pr) => pr.draft);
  }

  /**
   * Find PRs ready to merge
   *
   * @param repositoryId - Optional repository filter
   * @returns Array of mergeable PRs
   */
  async findReadyToMerge(repositoryId?: string): Promise<PullRequest[]> {
    const openPRs = await this.findOpen(repositoryId);
    return openPRs.filter((pr) => !pr.draft && pr.mergeable);
  }

  /**
   * Find PRs by branch
   *
   * @param branch - Branch name (head or base)
   * @param repositoryId - Optional repository filter
   * @returns Array of PRs
   */
  async findByBranch(
    branch: string,
    repositoryId?: string,
  ): Promise<PullRequest[]> {
    const prs = await this.list({
      where: repositoryId ? { repositoryId } : {},
    });

    return prs.filter((pr) => pr.headRef === branch || pr.baseRef === branch);
  }

  /**
   * Find PR by number in a repository
   *
   * @param repositoryId - Repository ID
   * @param number - PR number
   * @returns PullRequest or null
   */
  async findByNumber(
    repositoryId: string,
    number: number,
  ): Promise<PullRequest | null> {
    const results = await this.list({
      where: { repositoryId, number },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find PRs ready to merge (AI-powered)
   *
   * @param repositoryId - Optional repository filter
   * @returns Array of PRs that are ready
   */
  async findAIReadyToMerge(repositoryId?: string): Promise<PullRequest[]> {
    const openPRs = await this.findOpen(repositoryId);
    const ready: PullRequest[] = [];

    for (const pr of openPRs) {
      if (await pr.isReadyToMerge()) {
        ready.push(pr);
      }
    }

    return ready;
  }

  /**
   * Get PRs by change size
   *
   * @param size - Size classification
   * @param repositoryId - Optional repository filter
   * @returns Array of PRs
   */
  async findBySize(
    size: 'xs' | 's' | 'm' | 'l' | 'xl',
    repositoryId?: string,
  ): Promise<PullRequest[]> {
    const prs = await this.findOpen(repositoryId);
    return prs.filter((pr) => pr.getChangeSize() === size);
  }

  /**
   * Batch sync PRs from repository
   *
   * @param repository - Repository to sync from
   * @param options - Sync options
   * @returns Array of synced PRs
   */
  async batchSync(
    repository: Repository,
    options: { force?: boolean } = {},
  ): Promise<PullRequest[]> {
    const prs = await this.findByRepository(repository.id as string);
    const synced: PullRequest[] = [];

    for (const pr of prs) {
      await pr.sync(options);
      synced.push(pr);
    }

    return synced;
  }

  /**
   * Find pull requests by tenant ID
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of pull requests for the tenant
   */
  async findByTenant(tenantId: string): Promise<PullRequest[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find global pull requests (no tenant)
   *
   * @returns Array of global pull requests
   */
  async findGlobal(): Promise<PullRequest[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find pull requests for a tenant including global pull requests
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of tenant and global pull requests
   */
  async findWithGlobals(tenantId: string): Promise<PullRequest[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
