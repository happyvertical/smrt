import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface ContentReferenceOptions extends SmrtObjectOptions {
  sourceId?: string;
  targetId?: string;
  tenantId?: string | null;
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

  @foreignKey('Content', { required: true })
  sourceId = '';

  @foreignKey('Content', { required: true })
  targetId = '';

  @field()
  createdAt = new Date();

  constructor(options: ContentReferenceOptions = {}) {
    super(options);
    if (options.sourceId) this.sourceId = options.sourceId;
    if (options.targetId) this.targetId = options.targetId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
  }
}
