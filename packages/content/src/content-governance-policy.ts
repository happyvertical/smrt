import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type ContentReviewKind,
  type ContentReviewPolicyDefinition,
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
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_governance_policies',
  conflictColumns: ['key'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
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

  getMetadata(): Record<string, any> {
    if (this.metadata && typeof this.metadata === 'object') {
      return { ...(this.metadata as Record<string, any>) };
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
    const effective = await getEffectiveContentGovernanceConfig({
      db: this.db,
    });
    const hasFallback = hasStaticContentGovernancePolicy(this.key);
    const referencedBy = effective.profiles
      .filter((profile) =>
        profile.requirements.some(
          (requirement) => requirement.policyKey === this.key,
        ),
      )
      .map((profile) => profile.key);

    if (!hasFallback && referencedBy.length > 0) {
      throw new Error(
        `Cannot delete governance policy "${this.key}" because it is referenced by profiles: ${referencedBy.join(', ')}`,
      );
    }

    return super.delete();
  }
}
