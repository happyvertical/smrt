/**
 * AssetTag model - Links an asset to a `@happyvertical/smrt-tags` Tag.
 *
 * Backs the `asset_tags` join table that `AssetCollection.addTag()` /
 * `removeTag()` / `getByTag()` and `Asset.getTags()` / `hasTag()` use. Before
 * this model existed those methods wrote raw rows to an `asset_tags` table
 * that no manifest declared, so no migration ever created it.
 *
 * The link is keyed by the Tag's id (not its slug): a tag's natural key is
 * `(tenant, slug, context)`, so a slug alone is ambiguous across tenants and
 * contexts. Both sides cascade: deleting the asset or the tag removes the
 * link. Rows carry the asset's tenant.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface AssetTagOptions extends SmrtObjectOptions {
  assetId?: string;
  tagId?: string;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'asset_tags',
  conflictColumns: ['asset_id', 'tag_id'],
  api: false,
  mcp: false,
  cli: false,
})
export class AssetTag extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** FK to Asset.id — the link goes with the asset. */
  @foreignKey('Asset', { required: true, onDelete: 'CASCADE' })
  assetId = '';

  /** FK to smrt-tags Tag.id — the link goes with the tag. */
  @crossPackageRef('@happyvertical/smrt-tags:Tag', {
    required: true,
    onDelete: 'CASCADE',
  })
  tagId = '';

  constructor(options: AssetTagOptions = {}) {
    super(options);
    if (options.assetId) this.assetId = options.assetId;
    if (options.tagId) this.tagId = options.tagId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
