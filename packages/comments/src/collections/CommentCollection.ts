import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import { Comment } from '../models/Comment.js';

export class CommentCollection extends SmrtCollection<Comment> {
  static readonly _itemClass = Comment;

  async listForRecord(
    recordType: string,
    recordId: string,
  ): Promise<Comment[]> {
    const tenantId = getCurrentTenant()?.tenantId;
    if (!tenantId) {
      throw new TenantIsolationError(
        'Record comments require a tenant context.',
      );
    }
    return this.list({
      where: { tenantId, metaType: recordType, metaId: recordId },
      orderBy: ['createdAt ASC'],
    });
  }
}
