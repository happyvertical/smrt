/**
 * IssueCollection - Collection manager for Issue objects
 *
 * Provides querying and discovery operations for Issue entities.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Issue } from '../models/Issue';
import type { Repository } from '../models/Repository';
import type { SearchFilters } from '../types';

export class IssueCollection extends SmrtCollection<Issue> {
  static readonly _itemClass = Issue;

  /**
   * Discover issues from a repository and sync to database
   *
   * This method:
   * 1. Fetches issues from the provider via SDK
   * 2. Creates/updates SMRT Issue records in the database
   * 3. Returns the synced Issue objects
   *
   * @param options - Discovery options
   * @returns Array of Issue objects
   */
  async discover(options: {
    repository: Repository;
    filters?: SearchFilters;
  }): Promise<Issue[]> {
    const { repository, filters } = options;
    const repositoryId = repository.id;

    if (!repositoryId) {
      throw new Error('Repository must be saved before discovering issues');
    }

    const repoClient = await repository.getClient();

    // Fetch issues from provider
    const remoteIssues = await repoClient.searchIssues('', filters);

    const issues: Issue[] = [];

    for (const remote of remoteIssues) {
      // Find existing issue by repository + number
      let issue = await this.findOne({
        where: {
          repositoryId,
          number: remote.number,
        },
      });

      if (!issue) {
        // Create new issue
        issue = await this.create({
          repositoryId,
          number: remote.number,
          nodeId: remote.id,
          title: remote.title,
          body: remote.body,
          state: remote.state,
          author: remote.author.login,
          labels: remote.labels.map((l) => l.name),
          assignees: remote.assignees.map((a) => a.login),
          commentsCount: remote.commentsCount,
          lastSyncedAt: new Date(),
        });
      } else {
        // Update existing issue
        issue.nodeId = remote.id;
        issue.title = remote.title;
        issue.body = remote.body;
        issue.state = remote.state;
        issue.author = remote.author.login;
        issue.labels = remote.labels.map((l) => l.name);
        issue.assignees = remote.assignees.map((a) => a.login);
        issue.commentsCount = remote.commentsCount;
        issue.lastSyncedAt = new Date();
      }

      await issue.save();
      issues.push(issue);
    }

    return issues;
  }

  /**
   * Find issues by repository
   *
   * @param repositoryId - Repository ID
   * @returns Array of issues
   */
  async findByRepository(repositoryId: string): Promise<Issue[]> {
    return await this.list({
      where: { repositoryId },
    });
  }

  /**
   * Find open issues
   *
   * @param repositoryId - Optional repository filter
   * @returns Array of open issues
   */
  async findOpen(repositoryId?: string): Promise<Issue[]> {
    const where: Record<string, any> = { state: 'open' };
    if (repositoryId) {
      where.repositoryId = repositoryId;
    }
    return await this.list({ where });
  }

  /**
   * Find issues by label
   *
   * @param label - Label name
   * @param repositoryId - Optional repository filter
   * @returns Array of issues with the label
   */
  async findByLabel(label: string, repositoryId?: string): Promise<Issue[]> {
    const issues = await this.list({
      where: repositoryId ? { repositoryId } : {},
    });

    // Filter by label (JSON array search)
    return issues.filter((issue) => issue.labels.includes(label));
  }

  /**
   * Find issues by assignee
   *
   * @param assignee - Assignee login
   * @param repositoryId - Optional repository filter
   * @returns Array of issues assigned to the user
   */
  async findByAssignee(
    assignee: string,
    repositoryId?: string,
  ): Promise<Issue[]> {
    const issues = await this.list({
      where: repositoryId ? { repositoryId } : {},
    });

    // Filter by assignee (JSON array search)
    return issues.filter((issue) => issue.assignees.includes(assignee));
  }

  /**
   * Find issues needing review (AI-powered)
   *
   * @param repositoryId - Optional repository filter
   * @returns Array of issues that need review
   */
  async findNeedingReview(repositoryId?: string): Promise<Issue[]> {
    const openIssues = await this.findOpen(repositoryId);
    const needingReview: Issue[] = [];

    for (const issue of openIssues) {
      if (await issue.needsReview()) {
        needingReview.push(issue);
      }
    }

    return needingReview;
  }

  /**
   * Find issue by number in a repository
   *
   * @param repositoryId - Repository ID
   * @param number - Issue number
   * @returns Issue or null
   */
  async findByNumber(
    repositoryId: string,
    number: number,
  ): Promise<Issue | null> {
    const results = await this.list({
      where: { repositoryId, number },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Get issues with unincorporated feedback
   *
   * Issues that have comments but haven't had feedback incorporated
   *
   * @param repositoryId - Optional repository filter
   * @returns Array of issues
   */
  async findWithUnincorporatedFeedback(
    repositoryId?: string,
  ): Promise<Issue[]> {
    const issues = await this.findOpen(repositoryId);

    return issues.filter(
      (issue) => issue.commentsCount > 0 && issue.synthesisCount === 0,
    );
  }

  /**
   * Batch sync issues from repository
   *
   * @param repository - Repository to sync from
   * @param options - Sync options
   * @returns Array of synced issues
   */
  async batchSync(
    repository: Repository,
    options: { force?: boolean } = {},
  ): Promise<Issue[]> {
    const issues = await this.findByRepository(repository.id as string);
    const synced: Issue[] = [];

    for (const issue of issues) {
      await issue.sync(options);
      synced.push(issue);
    }

    return synced;
  }

  /**
   * Find issues by tenant ID
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of issues for the tenant
   */
  async findByTenant(tenantId: string): Promise<Issue[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find global issues (no tenant)
   *
   * @returns Array of global issues
   */
  async findGlobal(): Promise<Issue[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find issues for a tenant including global issues
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of tenant and global issues
   */
  async findWithGlobals(tenantId: string): Promise<Issue[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
