import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { FactContentRelationship } from '@happyvertical/smrt-facts';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  buildContentGovernanceAssignmentKey,
  type ContentGovernanceAssignmentDefinition,
  getEffectiveContentGovernanceConfig,
} from './content-governance';

export interface ContentGovernanceAssignmentOptions extends SmrtObjectOptions {
  key?: string;
  label?: string;
  contentType?: string;
  contentVariant?: string | null;
  enabled?: boolean;
  factLinkingEnabled?: boolean;
  transparencyEnabled?: boolean;
  publicationProfileKey?: string | null;
  correctionProfileKey?: string | null;
  enforcePublishReadiness?: boolean;
  defaultFactRelationship?: FactContentRelationship;
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_governance_assignments',
  conflictColumns: ['key'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class ContentGovernanceAssignment extends SmrtObject {
  @field({ required: true })
  key = '';

  label = '';

  @field({ required: true })
  contentType = '';

  contentVariant = '';
  enabled = true;
  factLinkingEnabled = false;
  transparencyEnabled = false;
  publicationProfileKey = '';
  correctionProfileKey = '';
  enforcePublishReadiness = false;
  defaultFactRelationship: FactContentRelationship = 'supports';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentGovernanceAssignmentOptions = {}) {
    super(options);
    if (options.contentType !== undefined)
      this.contentType = options.contentType;
    if (options.contentVariant !== undefined)
      this.contentVariant = options.contentVariant || '';
    if (options.label !== undefined) this.label = options.label;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.factLinkingEnabled !== undefined)
      this.factLinkingEnabled = options.factLinkingEnabled;
    if (options.transparencyEnabled !== undefined)
      this.transparencyEnabled = options.transparencyEnabled;
    if (options.publicationProfileKey !== undefined)
      this.publicationProfileKey = options.publicationProfileKey || '';
    if (options.correctionProfileKey !== undefined)
      this.correctionProfileKey = options.correctionProfileKey || '';
    if (options.enforcePublishReadiness !== undefined)
      this.enforcePublishReadiness = options.enforcePublishReadiness;
    if (options.defaultFactRelationship !== undefined)
      this.defaultFactRelationship = options.defaultFactRelationship;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;

    this.key =
      options.key ||
      buildContentGovernanceAssignmentKey(
        this.contentType,
        this.contentVariant,
      );

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

  toDefinition(): ContentGovernanceAssignmentDefinition {
    return {
      key: this.key,
      label: this.label || '',
      contentType: this.contentType,
      contentVariant: this.contentVariant || '',
      enabled: this.enabled !== false,
      factLinkingEnabled: this.factLinkingEnabled === true,
      transparencyEnabled: this.transparencyEnabled === true,
      publicationProfileKey: this.publicationProfileKey || null,
      correctionProfileKey: this.correctionProfileKey || null,
      enforcePublishReadiness: this.enforcePublishReadiness === true,
      defaultFactRelationship: this.defaultFactRelationship || 'supports',
      metadata: this.getMetadata(),
    };
  }

  protected override async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();

    this.key = buildContentGovernanceAssignmentKey(
      this.contentType,
      this.contentVariant,
    );

    const effective = await getEffectiveContentGovernanceConfig({
      db: this.db,
    });
    const availableProfileKeys = new Set(
      effective.profiles.map((profile) => profile.key),
    );
    const missingProfiles = [
      this.publicationProfileKey,
      this.correctionProfileKey,
    ].filter(
      (profileKey) => profileKey && !availableProfileKeys.has(profileKey),
    );

    if (missingProfiles.length > 0) {
      throw new Error(
        `Cannot save governance assignment "${this.key}" because these profiles are missing: ${missingProfiles.join(', ')}`,
      );
    }
  }
}
