/**
 * Example s-m-r-t object.
 *
 * This is a sample SMRT object to demonstrate the pattern.
 * Rename or replace this with your own objects.
 */

import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
    writable: ['title', 'description', 'status'],
  },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped({ mode: 'optional' })
export class Item extends SmrtObject {
  /** Null rows are global; tenant rows are isolated automatically. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Item title */
  title: string = '';

  /** Item description */
  description: string = '';

  /** Status of the item */
  status: string = 'draft';
}

/** Explicit collection constructor used by generated CLI/MCP/runtime tools. */
export class ItemCollection extends SmrtCollection<Item> {
  static readonly _itemClass = Item;
}

ObjectRegistry.registerCollection('Item', ItemCollection);
