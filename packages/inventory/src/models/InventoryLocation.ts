/**
 * InventoryLocation — a physical or virtual place where stock can sit.
 *
 * `kind` is intentionally a free-form string (see
 * {@link InventoryLocationKind}). Common values are `'warehouse'`,
 * `'factory'`, `'retail'`, `'in_transit'`, or `'virtual'`, but the
 * framework does not special-case any of them. Each application is free
 * to extend the vocabulary.
 *
 * Locations may optionally point at a place row in
 * `@happyvertical/smrt-places` via the plain-string `placeId` — useful
 * when an InventoryLocation maps to a real-world address or POI. The
 * reference is a plain string id, not a `@foreignKey()`, to avoid a
 * cross-package dependency on `smrt-places`.
 *
 * @packageDocumentation
 */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { InventoryLocationKind } from '../types.js';

/**
 * Options accepted by the {@link InventoryLocation} constructor.
 */
export interface InventoryLocationOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  code?: string;
  name?: string;
  kind?: InventoryLocationKind;
  placeId?: string;
  active?: boolean;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'inventory_locations',
  conflictColumns: ['code', 'tenant_id'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class InventoryLocation extends SmrtObject {
  /** Tenant scope. `null` means the location record is global. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Short stable identifier (`'WH-EAST'`, `'STORE-42'`, `'IN-TRANSIT'`).
   * Together with `tenantId` this is the natural key.
   */
  @field({ required: true })
  code: string = '';

  /** Display name for UIs. */
  name: string = '';

  /**
   * Open-ended classifier (`'warehouse'`, `'factory'`, `'retail'`,
   * `'in_transit'`, `'virtual'`, or anything else your domain needs).
   * The framework never branches on this value.
   */
  kind: InventoryLocationKind = 'warehouse';

  /**
   * Optional plain-string reference to a `Place.id` in
   * `@happyvertical/smrt-places`. Cross-package id; intentionally not a
   * `@foreignKey()` so this package can be used without `smrt-places`
   * installed.
   */
  placeId: string = '';

  /** Soft-active flag — inactive locations stay queryable for history. */
  active: boolean = true;

  constructor(options: InventoryLocationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.code !== undefined) this.code = options.code;
    if (options.name !== undefined) this.name = options.name;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.placeId !== undefined) this.placeId = options.placeId;
    if (options.active !== undefined) this.active = options.active;
  }
}
