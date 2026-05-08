import { SmrtCollection } from '@happyvertical/smrt-core';
import { OAuthState } from '../oauth-state.js';

export class OAuthStateCollection extends SmrtCollection<OAuthState> {
  static readonly _itemClass = OAuthState;

  async findByState(state: string): Promise<OAuthState | null> {
    return this.get({ state });
  }

  async findExpired(now: Date = new Date()): Promise<OAuthState[]> {
    const states = await this.list({});
    return states.filter((state) => state.expiresAt.getTime() <= now.getTime());
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.findExpired(now);
    await Promise.all(expired.map((state) => state.delete()));
    return expired.length;
  }
}
