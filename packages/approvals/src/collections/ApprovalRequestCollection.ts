/**
 * Collection for {@link ApprovalRequest}. Reads only: every write goes
 * through `ApprovalService`.
 *
 * @packageDocumentation
 */

import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ApprovalRequest } from '../models/ApprovalRequest.js';

/** Tenant-scoped reads of {@link ApprovalRequest} rows. */
// Core applies a collection's `@smrt()` config to its item class as well,
// and an undecorated collection keeps its own registry entry with the
// full-CRUD default. Repeat the model's read-only surface exactly.
@smrt({
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
})
export class ApprovalRequestCollection extends SmrtCollection<ApprovalRequest> {
  static readonly _itemClass = ApprovalRequest;
}
