/**
 * EmailAttachmentCollection - Backward-compatible collection for EmailAttachment
 *
 * @deprecated Use AttachmentCollection instead
 */

import { EmailAttachment } from '../models/EmailAttachment';
import { AttachmentCollection } from './AttachmentCollection';

/**
 * @deprecated Use AttachmentCollection instead
 */
export class EmailAttachmentCollection extends AttachmentCollection {
  static override readonly _itemClass = EmailAttachment;

  /**
   * Get attachments for an email
   * @deprecated Use getByMessage() instead
   */
  async getByEmail(emailId: string): Promise<EmailAttachment[]> {
    return (await this.getByMessage(emailId)) as EmailAttachment[];
  }

  /**
   * Get image attachments
   */
  override async getImages(emailId?: string): Promise<EmailAttachment[]> {
    return (await super.getImages(emailId)) as EmailAttachment[];
  }

  /**
   * Get PDF attachments
   */
  override async getPdfs(emailId?: string): Promise<EmailAttachment[]> {
    return (await super.getPdfs(emailId)) as EmailAttachment[];
  }

  /**
   * Get inline attachments
   */
  override async getInline(emailId: string): Promise<EmailAttachment[]> {
    return (await super.getInline(emailId)) as EmailAttachment[];
  }

  /**
   * Get regular attachments
   */
  override async getRegular(emailId: string): Promise<EmailAttachment[]> {
    return (await super.getRegular(emailId)) as EmailAttachment[];
  }

  /**
   * Delete all attachments for an email
   * @deprecated Use deleteByMessage() instead
   */
  async deleteByEmail(emailId: string): Promise<number> {
    return await this.deleteByMessage(emailId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  override async findByTenant(tenantId: string): Promise<EmailAttachment[]> {
    return this.list({ where: { tenantId } }) as Promise<EmailAttachment[]>;
  }

  override async findGlobal(): Promise<EmailAttachment[]> {
    return this.list({ where: { tenantId: null } }) as Promise<
      EmailAttachment[]
    >;
  }

  override async findWithGlobals(tenantId: string): Promise<EmailAttachment[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    ) as Promise<EmailAttachment[]>;
  }
}
