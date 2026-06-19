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
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AssetAssociationOptions } from './types';

@TenantScoped({ mode: 'optional' })
@smrt({
  conflictColumns: ['asset_id', 'meta_type', 'meta_id', 'role'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetAssociation extends SmrtPolymorphicAssociation {
  /**
   * Optional tenant scope. Without this, the generated `api`/`mcp` `create`
   * routes let any caller forge a polymorphic link between an asset and an
   * arbitrary object across tenant boundaries — the #1540 generated-route
   * tenant-context fix only filters models that ARE `@TenantScoped`, so this
   * model must opt in to be covered (S5 #1396).
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** FK to Asset.id */
  @foreignKey('Asset', { required: true })
  assetId = '';

  constructor(options: AssetAssociationOptions = {}) {
    super(options);
    if (options.assetId) this.assetId = options.assetId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
