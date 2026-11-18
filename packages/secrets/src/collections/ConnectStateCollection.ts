/**
 * ConnectStateCollection: the `ConnectStateStore` smrt-secrets ships.
 * @packageDocumentation
 */

import { RuntimeError, SmrtCollection } from '@happyvertical/smrt-core';
import type {
  ConnectStateRecord,
  ConnectStateStore,
} from '../connect/types.js';
import { ConnectState } from '../models/ConnectState.js';

export class ConnectStateCollection extends SmrtCollection<ConnectState> {
  static readonly _itemClass = ConnectState;

  /** The `ConnectStateStore` contract over this collection. */
  asStore(): ConnectStateStore {
    return {
      create: (input) => this.create({ ...input }),
      findByState: (state) => this.findByState(state),
      consume: (record) => this.consume(record),
    };
  }

  async findByState(state: string): Promise<ConnectState | null> {
    return this.get({ state });
  }

  /**
   * Delete a loaded state exactly once, with a revision-guarded delete: when
   * two callbacks race on the same state only one removes the row.
   */
  async consume(record: ConnectStateRecord): Promise<boolean> {
    const row = record as ConnectState;
    if (!row.id || !row.updated_at) return false;
    try {
      await row.delete({ expectedUpdatedAt: row.updated_at });
      return true;
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.code === 'RUNTIME_REVISION_CONFLICT'
      ) {
        return false;
      }
      throw error;
    }
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.list({ where: { 'expiresAt <=': now } });
    await Promise.all(expired.map((row) => row.delete()));
    return expired.length;
  }
}
