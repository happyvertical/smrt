/**
 * RepositoryCollection - Collection manager for Repository objects
 *
 * Provides querying and discovery operations for Repository entities.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Repository } from '../models/Repository';
import type { RepositoryProviderType } from '../types';

export class RepositoryCollection extends SmrtCollection<Repository> {
  static readonly _itemClass = Repository;

  /**
   * Find a repository by owner and name
   *
   * @param owner - Repository owner
   * @param name - Repository name
   * @returns Repository or null
   */
  async findByFullName(
    owner: string,
    name: string,
  ): Promise<Repository | null> {
    const results = await this.list({
      where: { owner, name },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find repositories by owner
   *
   * @param owner - Repository owner
   * @returns Array of repositories
   */
  async findByOwner(owner: string): Promise<Repository[]> {
    return await this.list({
      where: { owner },
    });
  }

  /**
   * Find repositories by provider type
   *
   * @param providerType - Provider type
   * @returns Array of repositories
   */
  async findByProvider(
    providerType: RepositoryProviderType,
  ): Promise<Repository[]> {
    return await this.list({
      where: { providerType },
    });
  }

  /**
   * Get or create a repository by owner/name
   *
   * @param owner - Repository owner
   * @param name - Repository name
   * @param options - Additional options for creation
   * @returns Repository (existing or newly created)
   */
  async getOrCreate(
    owner: string,
    name: string,
    options: {
      providerType?: RepositoryProviderType;
      tokenConfigKey?: string;
      baseUrl?: string;
    } = {},
  ): Promise<Repository> {
    let repo = await this.findByFullName(owner, name);

    if (!repo) {
      repo = await this.create({
        owner,
        name,
        fullName: `${owner}/${name}`,
        providerType: options.providerType || 'github',
        tokenConfigKey: options.tokenConfigKey || 'GITHUB_TOKEN',
        baseUrl: options.baseUrl || '',
      });
      await repo.save();
    }

    return repo;
  }

  /**
   * Sync all repositories
   *
   * @param options - Sync options
   * @returns Array of synced repositories
   */
  async syncAll(options: { force?: boolean } = {}): Promise<Repository[]> {
    const repos = await this.list({});
    const synced: Repository[] = [];

    for (const repo of repos) {
      await repo.sync(options);
      synced.push(repo);
    }

    return synced;
  }

  /**
   * Find repositories with open issues
   *
   * @returns Array of repositories with at least one open issue
   */
  async findWithOpenIssues(): Promise<Repository[]> {
    const repos = await this.list({});
    const withIssues: Repository[] = [];

    for (const repo of repos) {
      try {
        const issues = await repo.getIssues({ state: 'open', limit: 1 });
        if (issues.length > 0) {
          withIssues.push(repo);
        }
      } catch (error) {
        // Log error and skip repos we can't access
        console.warn(
          `Error accessing issues for repository ${repo.owner}/${repo.name}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return withIssues;
  }
}
