/**
 * Type definitions for @have/assets package
 */

import type {
  SmrtObjectOptions,
  SmrtPolymorphicAssociationOptions,
} from '@happyvertical/smrt-core';

/**
 * Options for creating an AssetType instance
 */
export interface AssetTypeOptions extends SmrtObjectOptions {
  slug?: string;
  name?: string;
  description?: string;
}

/**
 * Options for creating an AssetStatus instance
 */
export interface AssetStatusOptions extends SmrtObjectOptions {
  slug?: string;
  name?: string;
  description?: string;
}

/**
 * Options for creating an AssetMetafield instance
 */
export interface AssetMetafieldOptions extends SmrtObjectOptions {
  slug?: string;
  name?: string;
  validation?: string;
}

/**
 * Options for creating an Asset instance
 */
export interface AssetOptions extends SmrtObjectOptions {
  name?: string;
  slug?: string;
  sourceUri?: string;
  mimeType?: string;
  description?: string;
  metadata?: string | Record<string, unknown> | null;
  externalRefs?: string | Record<string, unknown> | null;
  version?: number;
  primaryVersionId?: string | null;
  typeSlug?: string;
  statusSlug?: string;
  ownerProfileId?: string | null;
  /**
   * FK to the source asset this one was derived from. Renamed from
   * `parentId` in R3-D — see `asset.ts` for context.
   */
  sourceAssetId?: string | null;
  folderId?: string | null;
  sourceType?: string;
  externalId?: string;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating an AssetAssociation instance.
 *
 * The polymorphic `metaType` / `metaId` / `role` / `sortOrder` options come
 * from `SmrtPolymorphicAssociationOptions`; this only adds the owner FK.
 */
export interface AssetAssociationOptions
  extends SmrtPolymorphicAssociationOptions {
  assetId?: string;
  tenantId?: string | null;
}

/**
 * Options for creating a Folder instance.
 *
 * Post R3-D: Folder no longer extends Asset. It's a top-level
 * SmrtHierarchical model with its own `folders` table.
 */
export interface FolderOptions extends SmrtObjectOptions {
  name?: string;
  slug?: string;
  description?: string;
  parentId?: string | null;
  ownerProfileId?: string | null;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}
