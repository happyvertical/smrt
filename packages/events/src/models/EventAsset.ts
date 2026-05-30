import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface EventAssetOptions extends SmrtObjectOptions {
  eventId?: string;
  assetId?: string;
  relationship?: string;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'event_assets',
  conflictColumns: ['event_id', 'asset_id', 'relationship'],
  api: false,
  mcp: false,
  cli: false,
})
export class EventAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Event', { required: true })
  eventId = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';

  @field({ required: true })
  relationship = 'attachment';

  @field()
  sortOrder = 0;

  constructor(options: EventAssetOptions = {}) {
    super(options);
    if (options.eventId) this.eventId = options.eventId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.relationship) this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
