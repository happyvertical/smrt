import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentGovernancePolicy } from './content-governance-policy';

export class ContentGovernancePolicyCollection extends SmrtCollection<ContentGovernancePolicy> {
  static readonly _itemClass = ContentGovernancePolicy;

  async getByKey(key: string): Promise<ContentGovernancePolicy | null> {
    return this.get({ key });
  }
}
