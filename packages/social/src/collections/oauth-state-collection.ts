import { RuntimeError, SmrtCollection } from '@happyvertical/smrt-core';
import { OAuthState } from '../oauth-state.js';

export class OAuthStateCollection extends SmrtCollection<OAuthState> {
  static readonly _itemClass = OAuthState;

  async findByState(state: string): Promise<OAuthState | null> {
    return this.get({ state });
  }

  /**
   * Consume a loaded state exactly once.
   *
   * Deletes the record with a revision-guarded delete, so when two callbacks
   * race on the same state only one delete removes the row. Returns `true`
   * for that caller and `false` for every caller whose row was already gone
   * or changed; any other failure propagates. Call it before acting on the
   * state (exchanging the code), and stop when it returns `false`.
   */
  async consume(state: OAuthState): Promise<boolean> {
    if (!state.id || !state.updated_at) return false;
    try {
      await state.delete({ expectedUpdatedAt: state.updated_at });
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

  async findExpired(now: Date = new Date()): Promise<OAuthState[]> {
    return this.list({
      where: { 'expiresAt <=': now },
      orderBy: 'expiresAt ASC',
    });
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.findExpired(now);
    await Promise.all(expired.map((state) => state.delete()));
    return expired.length;
  }
}
