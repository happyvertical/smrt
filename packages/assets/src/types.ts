/**
 * Type definitions for @have/assets package
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

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
  parentId?: string | null;
  folderId?: string | null;
  sourceType?: string;
  externalId?: string;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating an AssetAssociation instance
 */
export interface AssetAssociationOptions extends SmrtObjectOptions {
  assetId?: string;
  metaType?: string;
  metaId?: string;
  role?: string;
  sortOrder?: number;
}

/**
 * Options for creating a Folder instance
 */
export interface FolderOptions extends AssetOptions {}
