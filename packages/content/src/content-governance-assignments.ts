import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentGovernanceAssignment } from './content-governance-assignment';

export class ContentGovernanceAssignmentCollection extends SmrtCollection<ContentGovernanceAssignment> {
  static readonly _itemClass = ContentGovernanceAssignment;

  async getByKey(key: string): Promise<ContentGovernanceAssignment | null> {
    return this.get({ key });
  }

  async resolveForContent(options: {
    contentType: string;
    contentVariant?: string | null;
  }): Promise<ContentGovernanceAssignment | null> {
    const exact =
      (await this.get({
        key: `${options.contentType}::${options.contentVariant || ''}`,
      })) || null;

    if (exact) {
      return exact;
    }

    return this.get({
      key: `${options.contentType}::`,
    });
  }
}
