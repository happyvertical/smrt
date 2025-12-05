/**
 * EmailAccount model - Email account with sync capability
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import type {
  EmailAccountOptions,
  ProviderType,
  SyncOptions,
  SyncResult,
} from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class EmailAccount extends SmrtObject {
  name = '';
  email = '';
  providerType: ProviderType = 'imap';
  settings = ''; // JSON (connection settings - should be encrypted in production)
  lastSyncAt: Date | null = null;
  isActive = true;

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EmailAccountOptions = {}) {
    super(options);

    if (options.name !== undefined) this.name = options.name;
    if (options.email !== undefined) this.email = options.email;
    if (options.providerType !== undefined)
      this.providerType = options.providerType;
    if (options.settings !== undefined) this.settings = options.settings;
    if (options.lastSyncAt !== undefined)
      this.lastSyncAt = options.lastSyncAt || null;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get settings as parsed object
   */
  getSettings(): Record<string, any> {
    if (!this.settings) return {};
    try {
      return JSON.parse(this.settings);
    } catch {
      return {};
    }
  }

  /**
   * Set settings from object
   */
  setSettings(settings: Record<string, any>): void {
    this.settings = JSON.stringify(settings);
  }

  /**
   * Create an EmailClient from stored settings
   */
  async createClient() {
    const { getEmailClient } = await import('@happyvertical/email');
    const settings = this.getSettings();

    // Settings should contain auth and other required connection details
    // Cast to any since settings is a dynamic JSON object with all required fields
    return await getEmailClient({
      type: this.providerType,
      ...settings,
    } as any);
  }

  /**
   * Sync emails from the email server to the database
   */
  async syncFrom(options: SyncOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      folders: [],
      messagesProcessed: 0,
      messagesDownloaded: 0,
      messagesSkipped: 0,
      errors: [],
      duration: 0,
    };

    try {
      // Create email client
      const client = await this.createClient();
      await client.connect();

      // Get folders to sync
      const foldersToSync = options.folders || ['INBOX'];
      result.folders = foldersToSync;

      // Import collections
      const { EmailCollection } = await import(
        '../collections/EmailCollection'
      );
      const { EmailFolderCollection } = await import(
        '../collections/EmailFolderCollection'
      );

      const emailCollection = await (EmailCollection as any).create(
        this.options,
      );
      const folderCollection = await (EmailFolderCollection as any).create(
        this.options,
      );

      for (const folderName of foldersToSync) {
        try {
          // Ensure folder exists in database
          const accountId = this.id ?? '';
          let folder = await folderCollection.getByPath(accountId, folderName);

          if (!folder) {
            // Create folder record
            const { EmailFolder } = await import('./EmailFolder');
            folder = new EmailFolder({
              ...this.options,
              accountId,
              name: folderName,
              path: folderName,
            });
            await folder.save();
          }

          // Fetch messages from server
          const fetchOptions: Record<string, any> = {
            folder: folderName,
            limit: options.batchSize || 100,
          };

          if (options.since) {
            fetchOptions.since = options.since;
          }
          if (options.before) {
            fetchOptions.before = options.before;
          }

          const messages = await client.fetch(fetchOptions);

          for (const msg of messages) {
            result.messagesProcessed++;

            try {
              // Check if message already exists
              const existingEmail = await emailCollection.getByMessageId(
                this.id,
                msg.messageId || '',
              );

              if (existingEmail && !options.fullSync) {
                result.messagesSkipped++;
                continue;
              }

              // Create or update email record
              const { Email } = await import('./Email');
              const email =
                existingEmail ||
                new Email({
                  ...this.options,
                  accountId,
                });

              // Update fields
              email.messageId = msg.messageId || '';
              email.threadId = msg.threadId || '';
              email.inReplyTo = msg.inReplyTo || '';
              email.fromAddress = msg.from?.address || '';
              email.fromName = msg.from?.name || '';
              email.toAddresses = JSON.stringify(msg.to || []);
              email.ccAddresses = JSON.stringify(msg.cc || []);
              email.bccAddresses = JSON.stringify(msg.bcc || []);
              email.replyToAddress = msg.replyTo?.address || '';
              email.replyToName = msg.replyTo?.name || '';
              email.subject = msg.subject || '';
              email.date = msg.date || null;
              email.textBody = msg.text || '';
              email.htmlBody = msg.html || '';
              email.folderId = folder.id;
              email.folderPath = folderName;
              email.labels = JSON.stringify(msg.labels || []);
              email.flags = JSON.stringify(msg.flags || []);
              email.hasAttachments =
                (msg.attachments && msg.attachments.length > 0) || false;
              email.size = msg.size || 0;
              email.headers = JSON.stringify(msg.headers || {});
              email.updatedAt = new Date();

              await email.save();
              result.messagesDownloaded++;

              // Report progress
              if (options.onProgress) {
                options.onProgress({
                  folder: folderName,
                  processed: result.messagesProcessed,
                  total: messages.length,
                  downloaded: result.messagesDownloaded,
                  skipped: result.messagesSkipped,
                  errors: result.errors.length,
                });
              }
            } catch (error) {
              const err =
                error instanceof Error ? error : new Error(String(error));
              result.errors.push(err);
              if (options.onError) {
                options.onError(err, msg);
              }
            }
          }

          // Update folder counts
          folder.messageCount = await emailCollection.countByFolder(folder.id);
          folder.unreadCount = await emailCollection.countUnreadByFolder(
            folder.id,
          );
          await folder.save();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          result.errors.push(err);
          if (options.onError) {
            options.onError(err);
          }
        }
      }

      // Update last sync time
      this.lastSyncAt = new Date();
      this.updatedAt = new Date();
      await this.save();

      await client.disconnect();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      result.errors.push(err);
      if (options.onError) {
        options.onError(err);
      }
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Get all folders for this account
   */
  async getFolders() {
    const { EmailFolderCollection } = await import(
      '../collections/EmailFolderCollection'
    );
    const collection = await (EmailFolderCollection as any).create(
      this.options,
    );

    return await collection.list({ where: { accountId: this.id } });
  }

  /**
   * Get all emails for this account
   */
  async getEmails(limit?: number) {
    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    const options: Record<string, any> = { where: { accountId: this.id } };
    if (limit) {
      options.limit = limit;
    }

    return await collection.list(options);
  }

  /**
   * Get unread email count
   */
  async getUnreadCount(): Promise<number> {
    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    return await collection.countUnreadByAccount(this.id);
  }

  /**
   * Activate account
   */
  async activate(): Promise<void> {
    this.isActive = true;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Deactivate account
   */
  async deactivate(): Promise<void> {
    this.isActive = false;
    this.updatedAt = new Date();
    await this.save();
  }
}
