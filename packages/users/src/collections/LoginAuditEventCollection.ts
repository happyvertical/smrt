/**
 * Collection for {@link UsersLoginAuditEvent} — the default login audit sink's
 * storage, plus the retention primitive.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { UsersLoginAuditEvent } from '../models/LoginAuditEvent.js';

export class UsersLoginAuditEventCollection extends SmrtCollection<UsersLoginAuditEvent> {
  static readonly _itemClass = UsersLoginAuditEvent;

  /**
   * Delete events older than `maxAgeMs` (retention sweep). Returns the number
   * removed (or, under `dryRun`, matched).
   */
  async deleteOlderThan(
    maxAgeMs: number,
    options: { dryRun?: boolean } = {},
  ): Promise<number> {
    const floorIso = new Date(Date.now() - maxAgeMs).toISOString();
    const counted = await this.db.query(
      `SELECT COUNT(*) AS total FROM ${this.tableName} WHERE occurred_at < ?`,
      floorIso,
    );
    const total = Number(counted.rows?.[0]?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) return 0;
    if (!options.dryRun) {
      await this.db.query(
        `DELETE FROM ${this.tableName} WHERE occurred_at < ?`,
        floorIso,
      );
    }
    return total;
  }
}
