/**
 * AssetAssociation model - Links assets to any SmrtObject via polymorphic join
 *
 * Enables many-to-many relationships between assets and arbitrary objects
 * (e.g., Article, Profile, Event) with role-based categorization.
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { AssetAssociationOptions } from './types';

@smrt({
  conflictColumns: ['asset_id', 'meta_type', 'meta_id', 'role'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetAssociation extends SmrtObject {
  /** FK to Asset.id */
  @foreignKey('Asset', { required: true })
  assetId = '';

  /** Target class name or qualified name (e.g., 'Article' or '@pkg:Article') */
  @field({ required: true })
  metaType = '';

  /** Target object ID */
  @field({ required: true })
  metaId = '';

  /** Role of this association (e.g., 'hero', 'thumbnail', 'attachment') */
  @field({ required: true })
  role = 'default';

  /** Sort order for ordering assets within a role */
  @field()
  sortOrder: number = 0;

  constructor(options: AssetAssociationOptions = {}) {
    super(options);
    if (options.assetId) this.assetId = options.assetId;
    if (options.metaType) this.metaType = options.metaType;
    if (options.metaId) this.metaId = options.metaId;
    if (options.role) this.role = options.role;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }
}
