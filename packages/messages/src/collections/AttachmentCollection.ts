/**
 * AttachmentCollection - Generalized attachment collection using messageId
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { Attachment } from '../models/Attachment';

export class AttachmentCollection extends SmrtCollection<Attachment> {
  static readonly _itemClass = Attachment;

  /**
   * Get attachments for a message
   */
  async getByMessage(messageId: string): Promise<Attachment[]> {
    return await this.list({ where: { messageId } });
  }

  /**
   * Get attachments by content type
   */
  async getByContentType(contentType: string): Promise<Attachment[]> {
    return await this.list({ where: { contentType } });
  }

  /**
   * Get image attachments
   */
  async getImages(messageId?: string): Promise<Attachment[]> {
    const attachments = messageId
      ? await this.getByMessage(messageId)
      : await this.list({});

    return attachments.filter((a) => a.isImage());
  }

  /**
   * Get PDF attachments
   */
  async getPdfs(messageId?: string): Promise<Attachment[]> {
    const attachments = messageId
      ? await this.getByMessage(messageId)
      : await this.list({});

    return attachments.filter((a) => a.isPdf());
  }

  /**
   * Get inline attachments (embedded in message body)
   */
  async getInline(messageId: string): Promise<Attachment[]> {
    const attachments = await this.getByMessage(messageId);
    return attachments.filter((a) => a.isInline());
  }

  /**
   * Get regular attachments (not inline)
   */
  async getRegular(messageId: string): Promise<Attachment[]> {
    const attachments = await this.getByMessage(messageId);
    return attachments.filter((a) => !a.isInline());
  }

  /**
   * Get attachments with external files
   */
  async getWithExternalFiles(): Promise<Attachment[]> {
    const attachments = await this.list({});
    return attachments.filter((a) => a.hasExternalFile());
  }

  /**
   * Get total size of attachments for a message
   */
  async getTotalSize(messageId: string): Promise<number> {
    const attachments = await this.getByMessage(messageId);
    return attachments.reduce((sum, a) => sum + a.size, 0);
  }

  /**
   * Get largest attachments
   */
  async getLargest(limit = 10): Promise<Attachment[]> {
    const attachments = await this.list({});
    return attachments.sort((a, b) => b.size - a.size).slice(0, limit);
  }

  /**
   * Search attachments by filename
   */
  async searchByFilename(query: string): Promise<Attachment[]> {
    const attachments = await this.list({});
    const lowerQuery = query.toLowerCase();

    return attachments.filter((a) =>
      a.filename?.toLowerCase().includes(lowerQuery),
    );
  }

  /**
   * Get attachments by extension
   */
  async getByExtension(extension: string): Promise<Attachment[]> {
    const attachments = await this.list({});
    const lowerExt = extension.toLowerCase().replace(/^\./, '');

    return attachments.filter((a) => a.getExtension() === lowerExt);
  }

  /**
   * Get attachment statistics
   */
  async getStats(): Promise<{
    total: number;
    totalSize: number;
    byType: Record<string, number>;
    inline: number;
    regular: number;
  }> {
    const attachments = await this.list({});

    const byType: Record<string, number> = {};
    for (const attachment of attachments) {
      const type = attachment.contentType.split('/')[0] || 'other';
      byType[type] = (byType[type] || 0) + 1;
    }

    return {
      total: attachments.length,
      totalSize: attachments.reduce((sum, a) => sum + a.size, 0),
      byType,
      inline: attachments.filter((a) => a.isInline()).length,
      regular: attachments.filter((a) => !a.isInline()).length,
    };
  }

  /**
   * Delete all attachments for a message
   */
  async deleteByMessage(messageId: string): Promise<number> {
    const attachments = await this.getByMessage(messageId);
    let count = 0;

    for (const attachment of attachments) {
      await attachment.delete();
      count++;
    }

    return count;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  async findByTenant(tenantId: string): Promise<Attachment[]> {
    return this.list({ where: { tenantId } });
  }

  // Attachment is @TenantScoped (CTI, own `attachments` table). Under an active
  // tenant context list({ tenantId: null }) throws and unflagged raw SQL is
  // blocked (#1596); route through the raw helpers.
  async findGlobal(): Promise<Attachment[]> {
    return queryGlobal<Attachment>(this);
  }

  async findWithGlobals(tenantId: string): Promise<Attachment[]> {
    return queryWithGlobals<Attachment>(
      this,
      tenantId,
      'Attachment.findWithGlobals',
    );
  }
}
