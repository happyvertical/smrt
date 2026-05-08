import { SmrtCollection } from '@happyvertical/smrt-core';
import { OAuthState } from '../oauth-state.js';

export class OAuthStateCollection extends SmrtCollection<OAuthState> {
  static readonly _itemClass = OAuthState;

  async findByState(state: string): Promise<OAuthState | null> {
    return this.get({ state });
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
