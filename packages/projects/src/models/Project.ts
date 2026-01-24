/**
 * Project model - SMRT wrapper for project board operations
 *
 * Provides persistent project tracking with provider-agnostic operations.
 * Uses @happyvertical/projects SDK for actual API calls.
 */

import { getProject } from '@happyvertical/projects';
import { getModuleConfig } from '@happyvertical/smrt-config';
import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { SYNC_THROTTLE_MS } from '../constants';
import type {
  IProject,
  ItemFilters,
  ProjectField,
  ProjectItem,
  ProjectProviderType,
  ProjectStatus,
  SDKProject,
  SyncOptions,
} from '../types';
import type { Issue } from './Issue';
import type { PullRequest } from './PullRequest';

export interface ProjectOptions extends SmrtObjectOptions {
  projectId?: string;
  projectNumber?: number;
  title?: string;
  description?: string;
  owner?: string;
  url?: string;
  providerType?: ProjectProviderType;
  tokenConfigKey?: string;
  statuses?: ProjectStatus[];
  fields?: ProjectField[];
  statusFieldId?: string;
  statusOptions?: Record<string, string>;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'sync', 'addItem', 'updateItemStatus'] },
  cli: {
    include: [
      'list',
      'get',
      'sync',
      'addItem',
      'updateItemStatus',
      'listItems',
    ],
  },
})
export class Project extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId = tenantId({ nullable: true });

  /**
   * Provider-specific project ID (e.g., GitHub GraphQL node ID)
   */
  projectId: string = '';

  /**
   * Human-readable project number
   */
  projectNumber: number = 0;

  /**
   * Project title
   */
  title: string = '';

  /**
   * Project description
   */
  description: string = '';

  /**
   * Project owner (organization or user)
   */
  owner: string = '';

  /**
   * Project URL
   */
  url: string = '';

  /**
   * Project provider type
   */
  providerType: ProjectProviderType = 'github';

  /**
   * Environment variable name or config key for token resolution
   */
  tokenConfigKey: string = 'GITHUB_TOKEN';

  /**
   * Available statuses (columns) in the project
   */
  statuses: ProjectStatus[] = [];

  /**
   * Custom fields defined in the project
   */
  fields: ProjectField[] = [];

  /**
   * Status field ID for GitHub Projects V2
   */
  statusFieldId: string = '';

  /**
   * Maps status name to option ID (for GitHub Projects V2)
   */
  statusOptions: Record<string, string> = {};

  /**
   * Last sync timestamp
   */
  lastSyncedAt: Date | null = null;

  /**
   * Transient: Cached project client (not persisted)
   */
  private _client?: IProject;

  constructor(options: ProjectOptions = {}) {
    super(options);
    if (options.projectId !== undefined) this.projectId = options.projectId;
    if (options.projectNumber !== undefined)
      this.projectNumber = options.projectNumber;
    if (options.title !== undefined) this.title = options.title;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.owner !== undefined) this.owner = options.owner;
    if (options.url !== undefined) this.url = options.url;
    if (options.providerType !== undefined)
      this.providerType = options.providerType;
    if (options.tokenConfigKey !== undefined)
      this.tokenConfigKey = options.tokenConfigKey;
    if (options.statuses !== undefined) this.statuses = options.statuses;
    if (options.fields !== undefined) this.fields = options.fields;
    if (options.statusFieldId !== undefined)
      this.statusFieldId = options.statusFieldId;
    if (options.statusOptions !== undefined)
      this.statusOptions = options.statusOptions;
    if (options.tenantId !== undefined)
      (this as any).tenantId = options.tenantId;
  }

  /**
   * Get the project client, resolving token from config
   *
   * @returns Project client for API operations
   * @throws Error if token cannot be resolved
   */
  async getClient(): Promise<IProject> {
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

    this._client = await getProject({
      type: this.providerType,
      projectId: this.projectId,
      token,
      statusFieldId: this.statusFieldId || undefined,
      statusOptions:
        Object.keys(this.statusOptions).length > 0
          ? this.statusOptions
          : undefined,
    });

    return this._client;
  }

  /**
   * Clear the cached client
   */
  clearClient(): void {
    this._client = undefined;
  }

  /**
   * Sync project metadata from the provider
   *
   * @param options - Sync options
   * @returns This project with updated fields
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
    const projectData: SDKProject = await client.getProject();

    // Update fields from remote
    this.title = projectData.title;
    this.description = projectData.description || '';
    this.owner = projectData.owner;
    this.url = projectData.url;
    this.statuses = projectData.statuses;
    this.fields = projectData.fields;
    this.lastSyncedAt = new Date();

    await this.save();
    return this;
  }

  /**
   * Add an issue or PR to this project
   *
   * @param item - Issue or PullRequest to add
   * @returns Created ProjectItem
   */
  async addItem(item: Issue | PullRequest): Promise<ProjectItem> {
    if (!item.nodeId) {
      throw new Error('Item must have a nodeId (sync the item first)');
    }

    const client = await this.getClient();
    return await client.addItem(item.nodeId);
  }

  /**
   * Remove an item from this project
   *
   * @param itemId - Project item ID to remove
   */
  async removeItem(itemId: string): Promise<void> {
    const client = await this.getClient();
    await client.removeItem(itemId);
  }

  /**
   * Get a specific item from the project
   *
   * @param itemId - Project item ID
   * @returns ProjectItem or null
   */
  async getItem(itemId: string): Promise<ProjectItem | null> {
    const client = await this.getClient();
    return await client.getItem(itemId);
  }

  /**
   * List items in this project
   *
   * @param filters - Optional filters
   * @returns Array of ProjectItems
   */
  async listItems(filters?: ItemFilters): Promise<ProjectItem[]> {
    const client = await this.getClient();
    return await client.listItems(filters);
  }

  /**
   * Update an item's status (column)
   *
   * @param itemId - Project item ID
   * @param status - New status name
   */
  async updateItemStatus(itemId: string, status: string): Promise<void> {
    const client = await this.getClient();
    await client.updateItemStatus(itemId, status);
  }

  /**
   * Update an item's custom field
   *
   * @param itemId - Project item ID
   * @param fieldId - Field ID
   * @param value - New value
   */
  async updateItemField(
    itemId: string,
    fieldId: string,
    value: unknown,
  ): Promise<void> {
    const client = await this.getClient();
    await client.updateItemField(itemId, fieldId, value);
  }

  /**
   * Get available statuses
   *
   * @returns Array of status definitions
   */
  async getStatuses(): Promise<ProjectStatus[]> {
    if (this.statuses.length > 0) {
      return this.statuses;
    }

    const client = await this.getClient();
    this.statuses = await client.listStatuses();
    await this.save();
    return this.statuses;
  }

  /**
   * Get available fields
   *
   * @returns Array of field definitions
   */
  async getFields(): Promise<ProjectField[]> {
    if (this.fields.length > 0) {
      return this.fields;
    }

    const client = await this.getClient();
    this.fields = await client.listFields();
    await this.save();
    return this.fields;
  }

  /**
   * Get items in a specific status/column
   *
   * @param status - Status name
   * @returns Array of ProjectItems in that status
   */
  async getItemsByStatus(status: string): Promise<ProjectItem[]> {
    return await this.listItems({ status });
  }

  /**
   * Move an item to a new status
   *
   * @param item - Issue or PullRequest
   * @param status - Target status name
   */
  async moveItem(item: Issue | PullRequest, status: string): Promise<void> {
    // First, find the item in the project
    const items = await this.listItems();
    const projectItem = items.find((i) => i.contentId === item.nodeId);

    if (!projectItem) {
      throw new Error('Item not found in project');
    }

    await this.updateItemStatus(projectItem.id, status);
  }

  /**
   * AI-powered: Analyze project health and suggest improvements
   *
   * @returns Analysis of project status
   */
  async analyzeHealth(): Promise<string> {
    const items = await this.listItems();
    const statuses = await this.getStatuses();

    // Count items by status
    const statusCounts: Record<string, number> = {};
    for (const status of statuses) {
      statusCounts[status.name] = items.filter(
        (i) => i.status === status.name,
      ).length;
    }

    return await this.do(
      `Analyze the health of this project board and suggest improvements.

      Project: ${this.title}
      Description: ${this.description}

      Item distribution by status:
      ${Object.entries(statusCounts)
        .map(([status, count]) => `- ${status}: ${count} items`)
        .join('\n')}

      Total items: ${items.length}

      Provide:
      1. Overall health assessment
      2. Potential bottlenecks
      3. Suggestions for improvement`,
    );
  }

  /**
   * Get project by title
   *
   * @param title - Project title
   * @param options - Additional options
   * @returns Project or null
   */
  static async getByTitle(
    title: string,
    options: SmrtObjectOptions = {},
  ): Promise<Project | null> {
    const { ProjectCollection } = await import('../collections/Projects');
    const collection = await (ProjectCollection as any).create(options);
    return await collection.findByTitle(title);
  }
}
