/**
 * AssetAssociation model - Links assets to any SmrtObject via polymorphic join
 *
 * Enables many-to-many relationships between assets and arbitrary objects
 * (e.g., Article, Profile, Event) with role-based categorization.
 *
 * The polymorphic right side (`metaType` + `metaId` + `role` + `sortOrder`)
 * and the registry-aware `hydrate()` helper come from
 * `SmrtPolymorphicAssociation` in core; this class only adds the `assetId`
 * left/owner FK.
 */

import {
  foreignKey,
  SmrtPolymorphicAssociation,
  smrt,
} from '@happyvertical/smrt-core';
import type { AssetAssociationOptions } from './types';

@smrt({
  conflictColumns: ['asset_id', 'meta_type', 'meta_id', 'role'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetAssociation extends SmrtPolymorphicAssociation {
  /** FK to Asset.id */
  @foreignKey('Asset', { required: true })
  assetId = '';

  constructor(options: AssetAssociationOptions = {}) {
    super(options);
    if (options.assetId) this.assetId = options.assetId;
  }
}
