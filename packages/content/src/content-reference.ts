import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface ContentReferenceOptions extends SmrtObjectOptions {
  sourceId?: string;
  targetId?: string;
  tenantId?: string | null;
  // ContentVersion.version pinned at citation time. Optional: references
  // created without a pin behave as before (they track the live target).
  // When set, callers can compare against the target's latest version to
  // surface drift between what was cited and what the target now says.
  targetVersion?: number | null;
  createdAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_references',
  conflictColumns: ['source_id', 'target_id'],
})
export class ContentReference extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ required: true })
  sourceId = '';

  @field({ required: true })
  targetId = '';

  @field({ type: 'integer', nullable: true })
  targetVersion: number | null = null;

  @field()
  createdAt = new Date();

  constructor(options: ContentReferenceOptions = {}) {
    super(options);
    if (options.sourceId) this.sourceId = options.sourceId;
    if (options.targetId) this.targetId = options.targetId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.targetVersion !== undefined)
      this.targetVersion = options.targetVersion;
    if (options.createdAt) this.createdAt = options.createdAt;
  }
}
