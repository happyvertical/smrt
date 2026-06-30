/**
 * AccessRequestCollection — query helpers for {@link AccessRequest} records.
 *
 * This is the low-level data accessor. Lifecycle orchestration (the public-safe
 * create path, the state machine, capability gating, events, and graduation
 * into a `User`) lives in {@link AccessRequestService} — prefer the service for
 * application code.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AccessRequest } from '../models/AccessRequest.js';
import { normalizeEmail } from '../models/User.js';
import { AccessRequestStatus } from '../types/index.js';

/**
 * Collection for managing {@link AccessRequest} objects.
 */
export class AccessRequestCollection extends SmrtCollection<AccessRequest> {
  static readonly _itemClass = AccessRequest;

  /**
   * Find all access requests for an email (any status), newest first. The email
   * is normalized before querying so callers can pass any case.
   */
  async findByEmail(email: string): Promise<AccessRequest[]> {
    return await this.list({
      where: { email: normalizeEmail(email) },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find the single open (`REQUESTED`) request for an email, if any. This is
   * the dedup key used by {@link AccessRequestService.createAccessRequest}.
   */
  async findOpenByEmail(email: string): Promise<AccessRequest | null> {
    const results = await this.list({
      where: {
        email: normalizeEmail(email),
        status: AccessRequestStatus.REQUESTED,
      },
      limit: 1,
      orderBy: 'created_at DESC',
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find access requests by status, newest first.
   */
  async findByStatus(status: AccessRequestStatus): Promise<AccessRequest[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all open (`REQUESTED`) access requests — the operator triage queue.
   */
  async findOpen(): Promise<AccessRequest[]> {
    return await this.findByStatus(AccessRequestStatus.REQUESTED);
  }
}
