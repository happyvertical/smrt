/**
 * ProjectCollection - Collection manager for Project objects
 *
 * Provides querying and discovery operations for Project entities.
 */

import { createLogger } from '@happyvertical/logger';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { Project } from '../models/Project';
import type { ProjectProviderType } from '../types';

const logger = createLogger({ level: 'info' });

export class ProjectCollection extends SmrtCollection<Project> {
  static readonly _itemClass = Project;

  /**
   * Find project by title
   *
   * @param title - Project title
   * @returns Project or null
   */
  async findByTitle(title: string): Promise<Project | null> {
    const results = await this.list({
      where: { title },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find projects by owner
   *
   * @param owner - Project owner (organization or user)
   * @returns Array of projects
   */
  async findByOwner(owner: string): Promise<Project[]> {
    return await this.list({
      where: { owner },
    });
  }

  /**
   * Find projects by provider type
   *
   * @param providerType - Provider type
   * @returns Array of projects
   */
  async findByProvider(providerType: ProjectProviderType): Promise<Project[]> {
    return await this.list({
      where: { providerType },
    });
  }

  /**
   * Get or create a project by ID
   *
   * @param projectId - Provider-specific project ID
   * @param options - Additional options for creation
   * @returns Project (existing or newly created)
   */
  async getOrCreate(
    projectId: string,
    options: {
      title?: string;
      owner?: string;
      providerType?: ProjectProviderType;
      tokenConfigKey?: string;
      statusFieldId?: string;
      statusOptions?: Record<string, string>;
    } = {},
  ): Promise<Project> {
    let project = await this.findOne({
      where: { projectId },
    });

    if (!project) {
      project = await this.create({
        projectId,
        title: options.title || '',
        owner: options.owner || '',
        providerType: options.providerType || 'github',
        tokenConfigKey: options.tokenConfigKey || 'GITHUB_TOKEN',
        statusFieldId: options.statusFieldId || '',
        statusOptions: options.statusOptions || {},
      });
      await project.save();

      // Sync to get full project data
      await project.sync({ force: true });
    }

    return project;
  }

  /**
   * Sync all projects
   *
   * @param options - Sync options
   * @returns Array of synced projects
   */
  async syncAll(options: { force?: boolean } = {}): Promise<Project[]> {
    const projects = await this.list({});
    const synced: Project[] = [];

    for (const project of projects) {
      await project.sync(options);
      synced.push(project);
    }

    return synced;
  }

  /**
   * Find projects with items in a specific status
   *
   * @param status - Status name
   * @returns Array of projects
   */
  async findWithItemsInStatus(status: string): Promise<Project[]> {
    const projects = await this.list({});
    const matching: Project[] = [];

    for (const project of projects) {
      try {
        const items = await project.getItemsByStatus(status);
        if (items.length > 0) {
          matching.push(project);
        }
      } catch (error) {
        // Log error and skip projects we can't access
        logger.warn(`Error accessing items for project ${project.projectId}`, {
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    return matching;
  }

  /**
   * Get project statistics
   *
   * @param projectId - Project ID
   * @returns Statistics object
   */
  async getStatistics(projectId: string): Promise<{
    totalItems: number;
    itemsByStatus: Record<string, number>;
    itemsByType: Record<string, number>;
  }> {
    const project = await this.findOne({ where: { projectId } });
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const items = await project.listItems();
    const statuses = await project.getStatuses();

    const itemsByStatus: Record<string, number> = {};
    for (const status of statuses) {
      itemsByStatus[status.name] = 0;
    }

    const itemsByType: Record<string, number> = {
      Issue: 0,
      PullRequest: 0,
      DraftIssue: 0,
    };

    for (const item of items) {
      if (item.status && itemsByStatus[item.status] !== undefined) {
        itemsByStatus[item.status]++;
      }
      if (itemsByType[item.type] !== undefined) {
        itemsByType[item.type]++;
      }
    }

    return {
      totalItems: items.length,
      itemsByStatus,
      itemsByType,
    };
  }

  /**
   * Find projects by tenant ID
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of projects for the tenant
   */
  async findByTenant(tenantId: string): Promise<Project[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global projects (no tenant association).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global projects
   */
  async findGlobal(): Promise<Project[]> {
    return queryGlobal<Project>(this);
  }

  /**
   * Find projects for a tenant plus all global projects.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of tenant and global projects
   */
  async findWithGlobals(tenantId: string): Promise<Project[]> {
    return queryWithGlobals<Project>(this, tenantId, 'Project.findWithGlobals');
  }
}
