import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type ContentReviewKind,
  type ContentReviewPolicyDefinition,
  findTenantReferencesToGlobalKey,
  getEffectiveContentGovernanceConfig,
  getFallbackPolicyKind,
  hasStaticContentGovernancePolicy,
} from './content-governance';

export interface ContentGovernancePolicyOptions extends SmrtObjectOptions {
  key?: string;
  label?: string;
  kind?: ContentReviewKind;
  instructions?: string;
  enabled?: boolean;
  metadata?: string | Record<string, unknown>;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_governance_policies',
  // A key is unique per tenant: a tenant row overrides the global (NULL-tenant)
  // policy of the same key instead of colliding with it or with another
  // tenant's. Global rows stay unique on key through the null-aware upsert,
  // and in the database through NULLS NOT DISTINCT on PostgreSQL 15+ (#3305 M1).
  conflictColumns: ['tenant_id', 'key'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { skipApiCheck: true },
})
export class ContentGovernancePolicy extends SmrtObject {
  @field({ required: true })
  key = '';

  label = '';
  kind: ContentReviewKind = 'custom';
  instructions = '';
  enabled = true;
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentGovernancePolicyOptions = {}) {
    super(options);
    if (options.key !== undefined) this.key = options.key;
    if (options.label !== undefined) this.label = options.label;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.instructions !== undefined)
      this.instructions = options.instructions;
    if (options.enabled !== undefined) this.enabled = options.enabled;
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

  getMetadata(): Record<string, unknown> {
    if (this.metadata && typeof this.metadata === 'object') {
      return { ...(this.metadata as Record<string, unknown>) };
    }

    try {
      return this.metadata ? JSON.parse(this.metadata) : {};
    } catch {
      return {};
    }
  }

  toDefinition(): ContentReviewPolicyDefinition {
    return {
      key: this.key,
      label: this.label || this.key,
      kind: this.kind || getFallbackPolicyKind(this.key),
      instructions: this.instructions || '',
      enabled: this.enabled !== false,
      metadata: this.getMetadata(),
    };
  }

  override async delete(): Promise<void> {
    // Check references in this row's own scope (#3305 M1): a tenant row
    // against that tenant's overrides plus the global layer; a global row
    // also against every tenant that relies on it.
    const effective = await getEffectiveContentGovernanceConfig({
      db: this.db,
      tenantId: this.tenantId || undefined,
    });
    const hasFallback = hasStaticContentGovernancePolicy(this.key);
    const referencedBy = effective.profiles
      .filter((profile) =>
        profile.requirements.some(
          (requirement) => requirement.policyKey === this.key,
        ),
      )
      .map((profile) => profile.key);

    if (!this.tenantId && !hasFallback && referencedBy.length === 0) {
      referencedBy.push(
        ...(await findTenantReferencesToGlobalKey({
          db: this.db,
          kind: 'policy',
          key: this.key,
        })),
      );
    }

    if (!hasFallback && referencedBy.length > 0) {
      throw new Error(
        `Cannot delete governance policy "${this.key}" because it is referenced by profiles: ${referencedBy.join(', ')}`,
      );
    }

    return super.delete();
  }
}
