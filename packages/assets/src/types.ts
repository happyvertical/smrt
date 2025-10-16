/**
 * Type definitions for @have/assets package
 */

import type { SmrtObjectOptions } from '@smrt/core';

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
  version?: number;
  primaryVersionId?: string | null;
  typeSlug?: string;
  statusSlug?: string;
  ownerProfileId?: string | null;
  parentId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}
