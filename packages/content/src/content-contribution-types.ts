import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentContributionType } from './content-contribution-type';

export class ContentContributionTypeCollection extends SmrtCollection<ContentContributionType> {
  static readonly _itemClass = ContentContributionType;

  async getByKey(key: string): Promise<ContentContributionType | null> {
    return this.get({ key });
  }
}
