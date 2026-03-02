import { SmrtCollection } from '@happyvertical/smrt-core';
import { Blacklist } from '../models/Blacklist.js';

export class BlacklistCollection extends SmrtCollection<Blacklist> {
  static readonly _itemClass = Blacklist;

  /**
   * Check if an email is blacklisted
   */
  async isBlacklisted(email: string): Promise<boolean> {
    const entries = await this.list({});

    for (const entry of entries) {
      if (entry.matches(email)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the matching blacklist entry for an email
   */
  async getMatchingEntry(email: string): Promise<Blacklist | null> {
    const entries = await this.list({});

    for (const entry of entries) {
      if (entry.matches(email)) {
        return entry;
      }
    }

    return null;
  }
}
