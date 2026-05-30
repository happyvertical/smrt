import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ContentContributorTrustLevel } from './content-contribution-config';

export interface ContentContributorOptions extends SmrtObjectOptions {
  profileId?: string | null;
  email?: string;
  name?: string;
  trustLevel?: ContentContributorTrustLevel;
  metadata?: Record<string, any> | string;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function parseMetadata(raw: unknown): Record<string, any> {
  if (!raw) {
    return {};
  }

  if (typeof raw === 'object') {
    return { ...(raw as Record<string, any>) };
  }

  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_contributors',
  conflictColumns: ['email'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class ContentContributor extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId = '';

  @field({ required: true })
  email = '';

  name = '';
  trustLevel: ContentContributorTrustLevel = 'standard';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentContributorOptions = {}) {
    super(options);
    if (options.profileId !== undefined)
      this.profileId = options.profileId || '';
    if (options.email !== undefined)
      this.email = options.email.toLowerCase().trim();
    if (options.name !== undefined) this.name = options.name;
    if (options.trustLevel !== undefined) this.trustLevel = options.trustLevel;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getMetadata(): Record<string, any> {
    return parseMetadata(this.metadata);
  }

  setMetadata(metadata: Record<string, any>): void {
    this.metadata = JSON.stringify(metadata || {});
  }

  protected override transformJSON(json: Record<string, any>) {
    return {
      ...json,
      profileId: this.profileId || null,
      metadata: this.getMetadata(),
    };
  }
}
