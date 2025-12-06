/**
 * AuditLogCollection - Collection for querying audit logs
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AuditLog, type AuditSource } from '../models/AuditLog';
import type { Profile } from '../models/Profile';

export class AuditLogCollection extends SmrtCollection<AuditLog> {
  static readonly _itemClass = AuditLog;

  /**
   * Find logs for a profile (actions they performed)
   */
  async findByProfile(profileId: string): Promise<AuditLog[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'createdAt DESC',
    });
  }

  /**
   * Find logs for a resource
   */
  async findByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<AuditLog[]> {
    return await this.list({
      where: { resourceType, resourceId },
      orderBy: 'createdAt DESC',
    });
  }

  /**
   * Find logs by action type
   */
  async findByAction(action: string): Promise<AuditLog[]> {
    return await this.list({
      where: { action },
      orderBy: 'createdAt DESC',
    });
  }

  /**
   * Find logs by source
   */
  async findBySource(source: AuditSource): Promise<AuditLog[]> {
    return await this.list({
      where: { source },
      orderBy: 'createdAt DESC',
    });
  }

  /**
   * Find logs where actions were performed on behalf of someone
   */
  async findOnBehalfOf(profileId: string): Promise<AuditLog[]> {
    return await this.list({
      where: { onBehalfOfId: profileId },
      orderBy: 'createdAt DESC',
    });
  }

  /**
   * Record a new audit log entry
   */
  async record(options: {
    profile: Profile;
    action: string;
    resourceType: string;
    resourceId: string;
    source?: AuditSource;
    metadata?: Record<string, any>;
    onBehalfOf?: Profile | null;
  }): Promise<AuditLog> {
    const log = new AuditLog({
      ...this.options,
      profileId: options.profile.id as string,
      action: options.action,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      source: options.source || 'web',
      metadata: options.metadata || {},
      onBehalfOfId: options.onBehalfOf?.id as string | undefined,
    });
    await log.initialize();
    await log.save();
    return log;
  }

  /**
   * Get recent activity for a profile
   */
  async getRecentActivity(
    profileId: string,
    limit: number = 50,
  ): Promise<AuditLog[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'createdAt DESC',
      limit,
    });
  }

  /**
   * Get activity timeline for a resource
   */
  async getResourceTimeline(
    resourceType: string,
    resourceId: string,
  ): Promise<AuditLog[]> {
    return await this.list({
      where: { resourceType, resourceId },
      orderBy: 'createdAt ASC',
    });
  }
}
