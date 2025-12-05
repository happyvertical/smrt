/**
 * @happyvertical/smrt-messages
 *
 * SMRT-based email message persistence with AI integration
 *
 * @packageDocumentation
 */

// Export collections
export { EmailAccountCollection } from './collections/EmailAccountCollection';
export { EmailAttachmentCollection } from './collections/EmailAttachmentCollection';
export { EmailCollection } from './collections/EmailCollection';
export { EmailFolderCollection } from './collections/EmailFolderCollection';

// Export models
export { Email } from './models/Email';
export { EmailAccount } from './models/EmailAccount';
export { EmailAttachment } from './models/EmailAttachment';
export { EmailFolder } from './models/EmailFolder';

// Export types
export type {
  EmailAccountOptions,
  EmailAccountSearchFilters,
  EmailAttachmentOptions,
  EmailFolderOptions,
  EmailFolderSearchFilters,
  EmailOptions,
  EmailSearchFilters,
  ProviderType,
  SyncOptions,
  SyncProgress,
  SyncResult,
} from './types';
