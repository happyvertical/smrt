/**
 * EmailAttachment - Backward-compatible alias for Attachment
 *
 * @deprecated Use Attachment instead. EmailAttachment is preserved for backward compatibility.
 */

import type { EmailAttachmentOptions } from '../types';
import { Attachment } from './Attachment';

/**
 * @deprecated Use Attachment instead
 */
export class EmailAttachment extends Attachment {
  /**
   * Legacy emailId field — maps to messageId
   */
  get emailId(): string {
    return this.messageId;
  }

  set emailId(value: string) {
    this.messageId = value;
  }

  constructor(options: EmailAttachmentOptions = {}) {
    // Map emailId to messageId for backward compat
    const mappedOptions = {
      ...options,
      messageId: options.emailId || options.messageId || '',
    };
    super(mappedOptions);
  }

  /**
   * Get the email this attachment belongs to
   * @deprecated Use getMessage() instead
   */
  async getEmail() {
    if (!this.messageId) return null;

    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    return await collection.get({ id: this.messageId });
  }
}
