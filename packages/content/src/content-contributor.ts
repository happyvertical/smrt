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
  metadata?: Record<string, unknown> | string;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  if (typeof raw === 'object') {
    return { ...(raw as Record<string, unknown>) };
  }

  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_contributors',
  // Unique per tenant, not installation-wide: tenants each know their own
  // contributors, and global (NULL-tenant) rows stay unique on the normalized
  // email through the null-aware upsert, and in the database through NULLS NOT
  // DISTINCT on PostgreSQL 15+ (#3305 M1).
  conflictColumns: ['tenant_id', 'email'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { skipApiCheck: true },
})
export class ContentContributor extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId = '';

  @field({
    required: true,
    description: 'The email address the contributor writes in from.',
  })
  email = '';

  @field({ description: 'The name the contributor goes by.' })
  name = '';

  @field({
    description:
      'How far you trust what they send in: standard, trusted or blocked.',
  })
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

  /**
   * The key is `(tenant_id, email)` on the normalized address (#3305 M1).
   * The constructor normalizes, but generated create/update paths assign the
   * field after construction, so normalize again before every save.
   */
  protected override async validateBeforeSave(): Promise<void> {
    this.email = (this.email || '').toLowerCase().trim();
    await super.validateBeforeSave();
  }

  getMetadata(): Record<string, unknown> {
    return parseMetadata(this.metadata);
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata || {});
  }

  protected override transformJSON(json: Record<string, unknown>) {
    return {
      ...json,
      profileId: this.profileId || null,
      metadata: this.getMetadata(),
    };
  }
}
