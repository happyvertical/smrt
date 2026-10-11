/**
 * Collection for {@link ApprovalEvent}. Reads only: every write goes
 * through `ApprovalService`.
 *
 * @packageDocumentation
 */

import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ApprovalEvent } from '../models/ApprovalEvent.js';

/** Tenant-scoped reads of {@link ApprovalEvent} rows. */
// Core applies a collection's `@smrt()` config to its item class as well,
// and an undecorated collection keeps its own registry entry with the
// full-CRUD default. Repeat the model's read-only surface exactly.
@smrt({
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
})
export class ApprovalEventCollection extends SmrtCollection<ApprovalEvent> {
  static readonly _itemClass = ApprovalEvent;
}
