/**
 * Folder model — hierarchical container for organizing assets.
 *
 * Folders are now their own SmrtHierarchical model with their own `folders`
 * table (R3-D). Prior to R3-D, Folder was an STI subclass of Asset and
 * folder rows lived in the `assets` table with `type_slug='folder'`. The
 * column `assets.parent_id` did double duty: structural hierarchy for
 * folder rows, derivation source for asset rows.
 *
 * Splitting Folder onto its own table eliminates the overload and lets
 * Folder participate in the framework-wide `parentId` convention as a
 * SmrtHierarchical subclass (Place, Event, Tag, Account, Zone).
 *
 * Migration path (4 steps; see changeset):
 *
 *   1. Create `folders` table.
 *   2. Copy folder rows from `assets` (`type_slug='folder'`) into `folders`.
 *   3. On `assets`, rename `parent_id` → `source_asset_id` (handled in
 *      asset.ts schema generator output) and copy values for non-folder
 *      rows.
 *   4. Delete folder rows from `assets`.
 *
 * @see Asset.sourceAssetId for the renamed derivation pointer.
 */

import { SmrtHierarchical, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { FolderOptions } from './types';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Folder extends SmrtHierarchical {
  // Tenant isolation (optional — folders can be global or tenant-specific,
  // mirroring Asset's tenancy mode).
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  // Core fields. `parentId` is inherited from SmrtHierarchical.
  name = '';
  // `slug` is inherited as an accessor from SmrtObject.
  description = '';
  ownerProfileId: string | null = null;

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: FolderOptions = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.slug !== undefined) this.slug = options.slug;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.parentId !== undefined)
      this.parentId = options.parentId ?? null;
    if (options.ownerProfileId !== undefined)
      this.ownerProfileId = options.ownerProfileId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId as any;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  // Hierarchy traversal (getParent / getChildren / getAncestors /
  // getDescendants / getHierarchy / moveTo) provided by SmrtHierarchical.

  /**
   * Look up a folder by slug.
   */
  static async getBySlug(_slug: string): Promise<Folder | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
