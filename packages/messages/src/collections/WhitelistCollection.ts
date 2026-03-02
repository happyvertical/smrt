import { SmrtCollection } from '@happyvertical/smrt-core';
import { Whitelist } from '../models/Whitelist.js';

export class WhitelistCollection extends SmrtCollection<Whitelist> {
  static readonly _itemClass = Whitelist;

  /**
   * Check if an email is whitelisted for a specific category
   */
  async isWhitelisted(email: string, category?: string): Promise<boolean> {
    const entries = await this.list({});

    for (const entry of entries) {
      if (!entry.matches(email)) {
        continue;
      }

      if (!category) {
        return true;
      }

      if (entry.category === category || entry.category === null) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the matching whitelist entry for an email
   */
  async getMatchingEntry(email: string): Promise<Whitelist | null> {
    const entries = await this.list({});

    for (const entry of entries) {
      if (entry.matches(email)) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Get whitelist entries by category
   */
  async getByCategory(category: string): Promise<Whitelist[]> {
    return await this.list({
      where: { category },
    });
  }
}
