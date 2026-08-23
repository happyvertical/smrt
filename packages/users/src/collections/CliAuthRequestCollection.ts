/**
 * UsersCliAuthRequestCollection — lookups for the device-code grant flow.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { UsersCliAuthRequest } from '../models/CliAuthRequest.js';
import { SessionCollection } from './SessionCollection.js';

export interface ApprovePendingCliAuthRequestInput {
  approvedBy: string;
  ipAddress?: string;
  sessionTtlSeconds: number;
  tenantId: string;
  userAgent?: string;
  userCode: string;
  userId: string;
}

export interface ApprovedCliAuthRequestSnapshot {
  approvedAt: Date;
  id: string;
  sessionId: string;
  tenantId: string;
  userId: string;
}

class CliAuthApprovalLostError extends Error {}

export class UsersCliAuthRequestCollection extends SmrtCollection<UsersCliAuthRequest> {
  static readonly _itemClass = UsersCliAuthRequest;

  /**
   * Atomically approve one pending request and mint its bearer session.
   *
   * The session is created inside the same transaction as the conditional
   * pending-to-approved transition. If another approver wins, or persisting
   * the approval fails, throwing rolls the losing session back with the
   * request write so no usable orphan credential can remain.
   */
  async approvePendingRequest(
    input: ApprovePendingCliAuthRequestInput,
  ): Promise<ApprovedCliAuthRequestSnapshot | null> {
    const transaction = this.db.transaction?.bind(this.db);
    if (!transaction) {
      throw new Error(
        'Terminal approval requires database transaction support.',
      );
    }

    try {
      return await transaction(async (tx) => {
        const sessions = await SessionCollection.create({ db: tx });
        const session = await sessions.createSession({
          data: {
            approvedBy: input.approvedBy,
            kind: 'terminal',
          },
          ipAddress: input.ipAddress,
          tenantId: input.tenantId,
          ttl: input.sessionTtlSeconds,
          userAgent: input.userAgent,
          userId: input.userId,
        });
        const createdSessionId = session.id;
        if (!createdSessionId) {
          throw new Error('Terminal approval failed to mint a session.');
        }

        const approvedAt = new Date();
        const now = approvedAt.toISOString();
        const approved = await tx.query(
          `UPDATE ${this.tableName}
           SET approved_at = ?, session_id = ?, status = 'approved',
               tenant_id = ?, user_id = ?, updated_at = ?
           WHERE user_code = ? AND status = 'pending' AND expires_at > ?
           RETURNING id`,
          now,
          createdSessionId,
          input.tenantId,
          input.userId,
          now,
          input.userCode.trim().toUpperCase(),
          now,
        );
        if (approved.rows?.length !== 1) {
          throw new CliAuthApprovalLostError();
        }
        const id = approved.rows[0]?.id;
        if (typeof id !== 'string') {
          throw new Error('Terminal approval did not return its request id.');
        }
        return {
          approvedAt,
          id,
          sessionId: createdSessionId,
          tenantId: input.tenantId,
          userId: input.userId,
        };
      });
    } catch (error) {
      if (error instanceof CliAuthApprovalLostError) return null;
      throw error;
    }
  }

  /**
   * Atomically consume the bearer session attached to an approved request.
   *
   * The conditional update is the arbiter: concurrent exchangers may observe
   * the same candidate, but only one can change `approved` to `consumed` while
   * matching the same session id. The winning transaction returns the token
   * from its locked candidate and clears it from durable storage.
   */
  async consumeApprovedSession(deviceCodeHash: string): Promise<string | null> {
    const transaction = this.db.transaction?.bind(this.db);
    if (!transaction) {
      throw new Error(
        'Terminal device exchange requires database transaction support.',
      );
    }
    return transaction(async (tx) => {
      const selected = await tx.query(
        `SELECT id, session_id FROM ${this.tableName}
         WHERE device_code_hash = ? AND status = 'approved' AND session_id IS NOT NULL
         LIMIT 1`,
        deviceCodeHash,
      );
      const candidate = selected.rows?.[0];
      const id = typeof candidate?.id === 'string' ? candidate.id : null;
      const sessionId =
        typeof candidate?.session_id === 'string' ? candidate.session_id : null;
      if (!id || !sessionId) return null;

      const consumed = await tx.query(
        `UPDATE ${this.tableName}
         SET status = 'consumed', session_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'approved' AND session_id = ?
         RETURNING id`,
        new Date().toISOString(),
        id,
        sessionId,
      );
      return consumed.rows?.length === 1 ? sessionId : null;
    });
  }

  /**
   * Look up a pending or completed request by the short user code shown in the CLI.
   */
  async findByUserCode(userCode: string): Promise<UsersCliAuthRequest | null> {
    const [request] = await this.list({
      limit: 1,
      where: { userCode: userCode.trim().toUpperCase() },
    });
    return request ?? null;
  }

  /**
   * Look up a request by the hash of its device code (the CLI's polling key).
   */
  async findByDeviceCodeHash(
    deviceCodeHash: string,
  ): Promise<UsersCliAuthRequest | null> {
    const [request] = await this.list({
      limit: 1,
      where: { deviceCodeHash },
    });
    return request ?? null;
  }

  /**
   * Delete expired pending, lazily-expired, or already-consumed requests.
   *
   * Scheduled by the framework retention sweep (#2375); `expiresAt` carries an
   * index for this predicate.
   *
   * @param options.dryRun - Count the requests the predicate selects without
   *   deleting them.
   * @returns Number of requests deleted (or, under `dryRun`, matched)
   */
  async deleteExpired(options: { dryRun?: boolean } = {}): Promise<number> {
    // One statement, for the same reason `SessionCollection.deleteExpired()`
    // is one (#1400): this runs unattended on the retention sweep's timer, and
    // a per-row delete that throws part-way leaves the rest of the expired
    // requests un-reaped. It also avoids hydrating every row just to delete it.
    const now = new Date().toISOString();
    const predicate =
      "status IN ('pending', 'expired', 'consumed') AND expires_at < ?";

    const counted = await this.db.query(
      `SELECT COUNT(*) AS total FROM ${this.tableName} WHERE ${predicate}`,
      now,
    );
    const total = Number(counted.rows?.[0]?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) return 0;

    if (!options.dryRun) {
      await this.db.query(
        `DELETE FROM ${this.tableName} WHERE ${predicate}`,
        now,
      );
    }

    return total;
  }
}

export { UsersCliAuthRequestCollection as CliAuthRequestCollection };
