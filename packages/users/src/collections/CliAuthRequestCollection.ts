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
   */
  async deleteExpired(): Promise<number> {
    const requests = await this.list({
      where: {
        status: 'pending',
        'expiresAt <': new Date().toISOString(),
      },
    });

    let count = 0;
    for (const request of requests) {
      await request.delete();
      count++;
    }
    return count;
  }
}

export { UsersCliAuthRequestCollection as CliAuthRequestCollection };
