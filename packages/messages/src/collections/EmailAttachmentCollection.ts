/**
 * EmailAttachmentCollection - Collection manager for EmailAttachment objects
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { EmailAttachment } from '../models/EmailAttachment';

export class EmailAttachmentCollection extends SmrtCollection<EmailAttachment> {
  static readonly _itemClass = EmailAttachment;

  /**
   * Get attachments for an email
   */
  async getByEmail(emailId: string): Promise<EmailAttachment[]> {
    return await this.list({ where: { emailId } });
  }

  /**
   * Get attachments by content type
   */
  async getByContentType(contentType: string): Promise<EmailAttachment[]> {
    return await this.list({ where: { contentType } });
  }

  /**
   * Get image attachments
   */
  async getImages(emailId?: string): Promise<EmailAttachment[]> {
    const attachments = emailId
      ? await this.getByEmail(emailId)
      : await this.list({});

    return attachments.filter((a) => a.isImage());
  }

  /**
   * Get PDF attachments
   */
  async getPdfs(emailId?: string): Promise<EmailAttachment[]> {
    const attachments = emailId
      ? await this.getByEmail(emailId)
      : await this.list({});

    return attachments.filter((a) => a.isPdf());
  }

  /**
   * Get inline attachments (embedded in email body)
   */
  async getInline(emailId: string): Promise<EmailAttachment[]> {
    const attachments = await this.getByEmail(emailId);
    return attachments.filter((a) => a.isInline());
  }

  /**
   * Get regular attachments (not inline)
   */
  async getRegular(emailId: string): Promise<EmailAttachment[]> {
    const attachments = await this.getByEmail(emailId);
    return attachments.filter((a) => !a.isInline());
  }

  /**
   * Get attachments with external files
   */
  async getWithExternalFiles(): Promise<EmailAttachment[]> {
    const attachments = await this.list({});
    return attachments.filter((a) => a.hasExternalFile());
  }

  /**
   * Get total size of attachments for an email
   */
  async getTotalSize(emailId: string): Promise<number> {
    const attachments = await this.getByEmail(emailId);
    return attachments.reduce((sum, a) => sum + a.size, 0);
  }

  /**
   * Get largest attachments
   */
  async getLargest(limit = 10): Promise<EmailAttachment[]> {
    const attachments = await this.list({});
    return attachments.sort((a, b) => b.size - a.size).slice(0, limit);
  }

  /**
   * Search attachments by filename
   */
  async searchByFilename(query: string): Promise<EmailAttachment[]> {
    const attachments = await this.list({});
    const lowerQuery = query.toLowerCase();

    return attachments.filter((a) =>
      a.filename?.toLowerCase().includes(lowerQuery),
    );
  }

  /**
   * Get attachments by extension
   */
  async getByExtension(extension: string): Promise<EmailAttachment[]> {
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
   * Delete all attachments for an email
   */
  async deleteByEmail(emailId: string): Promise<number> {
    const attachments = await this.getByEmail(emailId);
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

  /**
   * Find all email attachments belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<EmailAttachment[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global email attachments (no tenant)
   */
  async findGlobal(): Promise<EmailAttachment[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find email attachments for a tenant including global attachments
   */
  async findWithGlobals(tenantId: string): Promise<EmailAttachment[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
