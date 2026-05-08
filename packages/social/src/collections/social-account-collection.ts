import { SmrtCollection } from '@happyvertical/smrt-core';
import { SocialAccount, type SocialPlatformType } from '../social-account.js';

export class SocialAccountCollection extends SmrtCollection<SocialAccount> {
  static readonly _itemClass = SocialAccount;

  async findActive(platform?: SocialPlatformType): Promise<SocialAccount[]> {
    const accounts = await this.list({
      where: {
        isActive: true,
        ...(platform ? { platform } : {}),
      },
      orderBy: 'name ASC',
    });

    return accounts;
  }

  async findReady(platform?: SocialPlatformType): Promise<SocialAccount[]> {
    const accounts = await this.findActive(platform);
    return accounts.filter((account) => account.isReady);
  }

  async findNeedsAttention(): Promise<SocialAccount[]> {
    const accounts = await this.list({
      where: { isActive: true },
      orderBy: 'name ASC',
    });
    return accounts.filter((account) => account.needsAttention);
  }
}
