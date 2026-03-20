import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type ContentGovernanceProfileDefinition,
  type ContentReviewRequirement,
  getEffectiveContentGovernanceConfig,
  hasStaticContentGovernanceProfile,
} from './content-governance';

export interface ContentGovernanceProfileOptions extends SmrtObjectOptions {
  key?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  requirements?: string | ContentReviewRequirement[];
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_governance_profiles',
  conflictColumns: ['key'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class ContentGovernanceProfile extends SmrtObject {
  @field({ required: true })
  key = '';

  label = '';
  description = '';
  enabled = true;
  requirements = '[]';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentGovernanceProfileOptions = {}) {
    super(options);
    if (options.key !== undefined) this.key = options.key;
    if (options.label !== undefined) this.label = options.label;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;

    if (options.requirements !== undefined) {
      this.requirements =
        typeof options.requirements === 'string'
          ? options.requirements
          : JSON.stringify(options.requirements);
    }

    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getRequirements(): ContentReviewRequirement[] {
    if (Array.isArray(this.requirements)) {
      return this.requirements as ContentReviewRequirement[];
    }

    try {
      return this.requirements ? JSON.parse(this.requirements) : [];
    } catch {
      return [];
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

  toDefinition(): ContentGovernanceProfileDefinition {
    return {
      key: this.key,
      label: this.label || this.key,
      description: this.description || '',
      enabled: this.enabled !== false,
      requirements: this.getRequirements(),
      metadata: this.getMetadata(),
    };
  }

  protected override async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();

    const effective = await getEffectiveContentGovernanceConfig({
      db: this.db,
    });
    const availablePolicyKeys = new Set(
      effective.policies.map((policy) => policy.key),
    );
    const missingPolicies = this.getRequirements()
      .map((requirement) => requirement.policyKey)
      .filter((policyKey) => !availablePolicyKeys.has(policyKey));

    if (missingPolicies.length > 0) {
      throw new Error(
        `Cannot save governance profile "${this.key}" because these policies are missing: ${missingPolicies.join(', ')}`,
      );
    }
  }

  override async delete(): Promise<void> {
    const effective = await getEffectiveContentGovernanceConfig({
      db: this.db,
    });
    const hasFallback = hasStaticContentGovernanceProfile(this.key);
    const referencedBy = effective.assignments
      .filter(
        (assignment) =>
          assignment.publicationProfileKey === this.key ||
          assignment.correctionProfileKey === this.key,
      )
      .map((assignment) => assignment.key || assignment.contentType);

    if (!hasFallback && referencedBy.length > 0) {
      throw new Error(
        `Cannot delete governance profile "${this.key}" because it is referenced by assignments: ${referencedBy.join(', ')}`,
      );
    }

    return super.delete();
  }
}
