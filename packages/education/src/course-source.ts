import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export type SourceSharing = 'private' | 'group' | 'global';
export type CourseSourceKind = 'manual' | 'url' | 'adapter';
export interface CourseSourceConfig {
  /** Host-recorded written permission for a shared import, never learner input. */
  licenseEvidence?: string;
}

/** Host-managed source policy; deliberately has no generated CRUD surface. */
@TenantScoped({ mode: 'required' })
@smrt({ api: false, cli: false, mcp: false })
export class CourseSource extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ required: true }) key = '';
  @field({ required: true }) name = '';
  kind: CourseSourceKind = 'adapter';
  adapterKey = 'easy-peasy';
  config = '{}';
  sharing: SourceSharing = 'private';

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options)) {
      if (Object.hasOwn(this, key))
        (this as unknown as Record<string, unknown>)[key] = value;
    }
  }

  getConfig(): CourseSourceConfig {
    const value: unknown = JSON.parse(this.config);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('CourseSource config must be an object.');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== 'licenseEvidence') ||
      (record.licenseEvidence !== undefined &&
        typeof record.licenseEvidence !== 'string')
    )
      throw new Error('Invalid CourseSource config.');
    return {
      ...(record.licenseEvidence === undefined
        ? {}
        : { licenseEvidence: record.licenseEvidence as string }),
    };
  }

  setConfig(value: CourseSourceConfig): void {
    const previous = this.config;
    this.config = JSON.stringify(value);
    try {
      this.getConfig();
    } catch (error) {
      this.config = previous;
      throw error;
    }
  }

  override async save(): Promise<this> {
    if (
      !['private', 'group', 'global'].includes(this.sharing) ||
      !['manual', 'url', 'adapter'].includes(this.kind)
    )
      throw new Error('Invalid CourseSource kind or sharing.');
    this.getConfig();
    return super.save();
  }
}

export class CourseSourceCollection extends SmrtCollection<CourseSource> {
  static readonly _itemClass = CourseSource;
}
