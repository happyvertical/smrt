/**
 * PipelineDefinition — a named, tenant-scoped sales pipeline.
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { PipelineDefinitionOptions, PipelineStatus } from '../types.js';

/**
 * PipelineDefinition names an ordered set of {@link PipelineStage | stages}
 * that opportunities move through. Pipelines are configuration rows, not
 * code: tenants can run several (e.g. `default`, `enterprise`, `renewals`)
 * and reshape stages freely without any Lead/Opportunity model change.
 *
 * The natural key is `(tenant_id, key)` (`conflictColumns`), so re-seeding a
 * pipeline with the same key upserts instead of duplicating. The seeded
 * default pipeline (key `'default'`, 7 stages) comes from
 * `PipelineDefinitionCollection.ensureDefaultPipeline()`.
 *
 * @example
 * ```typescript
 * const pipelines = await PipelineDefinitionCollection.create({ db });
 * const { pipeline, stages } = await pipelines.ensureDefaultPipeline();
 * const enterprise = await pipelines.create({
 *   key: 'enterprise',
 *   name: 'Enterprise motion',
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
  conflictColumns: ['tenant_id', 'key'],
})
export class PipelineDefinition extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global pipelines.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Stable machine key, unique per tenant (natural key with `tenantId`).
   * Required — e.g. `'default'`, `'enterprise'`.
   */
  @field({ required: true })
  key: string = '';

  /** Human-readable pipeline name shown on CRM surfaces. */
  name: string = '';

  /**
   * Marks the tenant's default pipeline. Informational for pickers/UI; the
   * seeded default pipeline sets it `true`.
   */
  isDefault: boolean = false;

  /** `active` pipelines accept new opportunities; `archived` are read-only history. */
  status: PipelineStatus = 'active';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: PipelineDefinitionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.key !== undefined) this.key = options.key;
    if (options.name !== undefined) this.name = options.name;
    if (options.isDefault !== undefined) this.isDefault = options.isDefault;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether the pipeline accepts new opportunities. */
  isActive(): boolean {
    return this.status === 'active';
  }

  /** Parse the metadata JSON string; returns `{}` on malformed content. */
  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Serialize and store the metadata object. */
  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }
}

export default PipelineDefinition;
