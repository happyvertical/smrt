/**
 * AuditLog - Tracks all actions for full audit trail
 *
 * Records who did what, when, and how (web, CLI, CI, webhook, MCP).
 * Supports pass-through identity for CI workflows.
 */

import {
  smrt,
  SmrtObject,
  foreignKey,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import type { Profile } from './Profile';

export type AuditSource = 'web' | 'cli' | 'ci' | 'webhook' | 'mcp';

export interface AuditLogOptions extends SmrtObjectOptions {
  profileId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  source?: AuditSource;
  metadata?: Record<string, any>;
  onBehalfOfId?: string | null;
}

@smrt({
  tableName: 'audit_logs',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list'] },
})
export class AuditLog extends SmrtObject {
  /**
   * The profile who performed the action
   */
  @foreignKey('Profile', { required: true })
  profileId?: string;

  /**
   * Action performed (e.g., 'issue.update', 'feedback.incorporate')
   */
  action: string = '';

  /**
   * Type of resource affected (e.g., 'Issue', 'Repository')
   */
  resourceType: string = '';

  /**
   * ID of the affected resource
   */
  resourceId: string = '';

  /**
   * Source of the action
   */
  source: AuditSource = 'web';

  /**
   * Additional context (CI run ID, request ID, etc.)
   */
  metadata: Record<string, any> = {};

  /**
   * For pass-through identity in CI - the actual person who triggered
   */
  @foreignKey('Profile', { nullable: true })
  onBehalfOfId?: string | null;

  constructor(options: AuditLogOptions = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.action) this.action = options.action;
    if (options.resourceType) this.resourceType = options.resourceType;
    if (options.resourceId) this.resourceId = options.resourceId;
    if (options.source) this.source = options.source;
    if (options.metadata) this.metadata = options.metadata;
    if (options.onBehalfOfId !== undefined) this.onBehalfOfId = options.onBehalfOfId;
  }

  /**
   * Get the profile who performed the action
   */
  async getProfile(): Promise<Profile | null> {
    return (await this.getRelated('profileId')) as Profile | null;
  }

  /**
   * Get the profile on whose behalf the action was performed (if any)
   */
  async getOnBehalfOf(): Promise<Profile | null> {
    if (!this.onBehalfOfId) return null;
    return (await this.getRelated('onBehalfOfId')) as Profile | null;
  }

  /**
   * Get the effective actor (onBehalfOf if set, otherwise profile)
   */
  async getEffectiveActor(): Promise<Profile | null> {
    const onBehalfOf = await this.getOnBehalfOf();
    if (onBehalfOf) return onBehalfOf;
    return await this.getProfile();
  }

  /**
   * Create an audit log entry
   */
  static async record(
    options: AuditLogOptions & {
      profile: Profile;
      onBehalfOf?: Profile | null;
    },
  ): Promise<AuditLog> {
    const log = new AuditLog({
      ...options,
      profileId: options.profile.id as string,
      onBehalfOfId: options.onBehalfOf?.id as string | undefined,
    });
    await log.initialize();
    await log.save();
    return log;
  }
}
