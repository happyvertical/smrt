/**
 * EmailAttachment model - Attachment metadata
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { EmailAttachmentOptions } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class EmailAttachment extends SmrtObject {
  tenantId = tenantId({ nullable: true });
  emailId = '';
  filename = '';
  contentType = '';
  size = 0;
  contentId = ''; // For inline images (<img src="cid:...">)
  contentDisposition: 'attachment' | 'inline' = 'attachment';
  filePath = ''; // External file storage path

  // Timestamps
  createdAt = new Date();

  constructor(options: EmailAttachmentOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId as any;
    if (options.emailId !== undefined) this.emailId = options.emailId;
    if (options.filename !== undefined) this.filename = options.filename;
    if (options.contentType !== undefined)
      this.contentType = options.contentType;
    if (options.size !== undefined) this.size = options.size;
    if (options.contentId !== undefined) this.contentId = options.contentId;
    if (options.contentDisposition !== undefined)
      this.contentDisposition = options.contentDisposition;
    if (options.filePath !== undefined) this.filePath = options.filePath;
    if (options.createdAt) this.createdAt = options.createdAt;
  }

  /**
   * Get the email this attachment belongs to
   */
  async getEmail() {
    if (!this.emailId) return null;

    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    return await collection.get({ id: this.emailId });
  }

  /**
   * Check if attachment is an image
   */
  isImage(): boolean {
    return this.contentType.startsWith('image/');
  }

  /**
   * Check if attachment is a PDF
   */
  isPdf(): boolean {
    return this.contentType === 'application/pdf';
  }

  /**
   * Check if attachment is inline (embedded in email body)
   */
  isInline(): boolean {
    return this.contentDisposition === 'inline';
  }

  /**
   * Get file extension from filename
   */
  getExtension(): string {
    if (!this.filename) return '';
    const parts = this.filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }

  /**
   * Get human-readable file size
   */
  getFormattedSize(): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = this.size;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Check if file is stored externally
   */
  hasExternalFile(): boolean {
    return !!this.filePath;
  }

  /**
   * Read file content (if stored externally)
   */
  async readContent(): Promise<Buffer | null> {
    if (!this.filePath) return null;

    try {
      const { getFilesystem } = await import('@happyvertical/files');
      const files = await getFilesystem({ type: 'local' });
      const data = await files.read(this.filePath);
      return data instanceof Buffer ? data : Buffer.from(data);
    } catch {
      return null;
    }
  }
}
