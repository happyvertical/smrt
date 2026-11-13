import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  type ApprovalOutcome,
  decideApproval,
  listApprovalViews,
} from '../server/approvals.ts';
import { assertOwner } from '../server/owner.ts';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'failed'
  | 'accepted'
  | 'executing'
  | 'expired';

// The decorator config must be a literal (the smrt() scanner reads it
// statically) and is repeated on the collection (core applies a collection's
// @smrt() config to its item class).

/**
 * Compatibility facade for installed Tricia approval storage and generated
 * decide/pending operations. The shared OwnerApprovalAuthority owns decisions
 * and consumption; the shell retains only its action/draft execution policy.
 */
@smrt({
  tableName: 'approvals',
  conflictColumns: ['id'],
  // Only the owner decides. The generated list/get/create/update/delete are
  // not exposed: the owner reads approvals through `pending` and
  // /api/shell/approvals, and rows are written only by the approval service.
  api: { include: ['decide', 'pending'] },
  mcp: { include: ['decide', 'pending'] },
  cli: false,
  operationPermissions: {
    decide: { action: 'update' },
    pending: { action: 'read' },
  },
})
export class Approval extends SmrtObject {
  /** The action to run on approval, JSON (`ApprovalAction`). */
  @field({ type: 'text' })
  command: string = '';

  /** Stable hash of the action; one pending row per identical action. */
  @field({ type: 'text' })
  actionKey: string = '';

  @field({ type: 'text' })
  summary: string = '';

  /** What the change would do (counts, affected methods), JSON. */
  @field({ type: 'text' })
  preview: string = '';

  @field({ type: 'text' })
  status: ApprovalStatus = 'pending';

  @field({ type: 'text' })
  requestedBy: string = '';

  @field({ type: 'text' })
  decidedBy: string = '';

  @field({ type: 'text' })
  decidedAt: string = '';

  /** The result of applying it, or the failure, JSON. */
  @field({ type: 'text' })
  result: string = '';

  @field({ type: 'text' })
  createdAt: string = '';

  /**
   * Approve (apply the change) or deny it. Owner only. Approving a change
   * that fails records the failure and leaves nothing half-applied.
   */
  async decide(approve: boolean): Promise<ApprovalOutcome> {
    const owner = await assertOwner();
    return decideApproval(this.id as string, approve === true, owner.id);
  }

  /** The approvals waiting for the owner. */
  static async pending() {
    await assertOwner();
    return listApprovalViews({ status: 'pending' });
  }
}

/**
 * Undecorated on purpose: the item class carries the whole surface (core
 * applies the collection's config to the item class, so a decorated
 * collection would have to repeat it exactly).
 */
export class ApprovalCollection extends SmrtCollection<Approval> {
  static readonly _itemClass = Approval;
}
