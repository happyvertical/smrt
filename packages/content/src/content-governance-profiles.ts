import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentGovernanceProfile } from './content-governance-profile';

export class ContentGovernanceProfileCollection extends SmrtCollection<ContentGovernanceProfile> {
  static readonly _itemClass = ContentGovernanceProfile;

  async getByKey(key: string): Promise<ContentGovernanceProfile | null> {
    return this.get({ key });
  }
}
