import {
  field,
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { validateCookbook } from '@happyvertical/smrt-core/cookbook';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';

export interface ProjectSpecificationOptions
  extends SmrtPolymorphicAssociationOptions {
  tenantId?: string;
  title?: string;
  summary?: string;
  cookbook?: string;
  revision?: number;
  actorType?: string;
  actorId?: string;
}

/** Canonical project requirements and their portable application cookbook. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_specifications',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['tenant_id', 'meta_type', 'meta_id'],
})
export class ProjectSpecification extends SmrtPolymorphicAssociation {
  @tenantId()
  tenantId = '';
  @field({ required: true })
  title = '';
  summary = '';
  /** Canonical Cookbook v1 JSON; use getCookbook(). */
  cookbook = '{}';
  revision = 1;
  actorType = '';
  actorId = '';

  constructor(options: ProjectSpecificationOptions = {}) {
    super({ ...options, role: 'specification' });
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.title !== undefined) this.title = options.title;
    if (options.summary !== undefined) this.summary = options.summary;
    if (options.cookbook !== undefined) this.cookbook = options.cookbook;
    if (options.revision !== undefined) this.revision = options.revision;
    if (options.actorType !== undefined) this.actorType = options.actorType;
    if (options.actorId !== undefined) this.actorId = options.actorId;
  }

  getCookbook(): Cookbook {
    const result = validateCookbook(JSON.parse(this.cookbook));
    if (!result.ok) throw new TypeError(result.errors.join('; '));
    return result.cookbook;
  }

  protected override async validateBeforeSave(): Promise<void> {
    this.title = this.title.trim();
    if (!this.title)
      throw new TypeError('Project specification title is required.');
    if (!Number.isSafeInteger(this.revision) || this.revision < 1)
      throw new TypeError(
        'Project specification revision must be a positive integer.',
      );
    if (
      !['user', 'agent', 'system'].includes(this.actorType) ||
      !this.actorId.trim()
    )
      throw new TypeError('Project specification actor is required.');
    this.cookbook = JSON.stringify(this.getCookbook());
    await super.validateBeforeSave();
  }
}
