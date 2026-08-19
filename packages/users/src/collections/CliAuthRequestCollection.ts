/**
 * UsersCliAuthRequestCollection — lookups for the device-code grant flow.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { UsersCliAuthRequest } from '../models/CliAuthRequest.js';

export class UsersCliAuthRequestCollection extends SmrtCollection<UsersCliAuthRequest> {
  static readonly _itemClass = UsersCliAuthRequest;

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
   * Delete expired pending requests (cleanup job).
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
    const predicate = "status = 'pending' AND expires_at < ?";

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
