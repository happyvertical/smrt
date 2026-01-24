/**
 * Type definitions for @happyvertical/smrt-properties
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

/**
 * Status of a digital property
 */
export type PropertyStatus = 'active' | 'inactive' | 'pending';

/**
 * Options for creating a Property instance
 */
export interface PropertyOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  name?: string;
  domain?: string;
  url?: string;
  description?: string;
  repositoryId?: string | null;
  ownerId?: string | null;
  status?: PropertyStatus;
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a Zone instance
 */
export interface ZoneOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  propertyId?: string;
  parentId?: string | null;
  name?: string;
  type?: string;
  path?: string;
  selector?: string;
  position?: string;
  width?: number | null;
  height?: number | null;
  allowedFormats?: string[];
  defaultContentId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * A node in the zone tree hierarchy
 */
export interface ZoneTreeNode<T = unknown> {
  zone: T;
  children: ZoneTreeNode<T>[];
}

/**
 * Complete zone tree for a property
 */
export interface ZoneTree<T = unknown> {
  propertyId: string;
  roots: ZoneTreeNode<T>[];
}
