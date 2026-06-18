/**
 * EmailAccount model - Email account extending the Account STI base
 *
 * Retains email-specific fields and sync capability.
 */

import { smrt } from '@happyvertical/smrt-core';
import type {
  EmailAccountOptions,
  MessageSenderInterface,
  ProviderType,
  SyncOptions,
  SyncResult,
} from '../types';
import { Account } from './Account';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class EmailAccount extends Account {
  email = '';
  syncIntervalMinutes = 60;

  constructor(options: EmailAccountOptions = {}) {
    super(options);

    if (options.email !== undefined) this.email = options.email;
    if (options.providerType !== undefined)
      this.providerType = options.providerType;
    if (options.syncIntervalMinutes !== undefined)
      this.syncIntervalMinutes = options.syncIntervalMinutes;
  }

  /**
   * Options for child rows (folders/emails) created during sync: carries the DB
   * connection + tenant context from this account, but strips this account's own
   * identity fields. When this account was hydrated from the DB, `this.options`
   * holds the account row's `id`/`slug`/`_skipLoad`; spreading those into a new
   * child would make every synced row inherit the account's primary key and
   * upsert over each other.
   */
  private childOptions(): Record<string, unknown> {
    const rest = { ...(this.options as Record<string, unknown>) };
    delete rest.id;
    delete rest.slug;
    delete rest._skipLoad;
    return rest;
  }

  /**
   * Create a sender for this email account
   */
  override async createSender(): Promise<MessageSenderInterface> {
    const client = await this.createClient();
    await client.connect();
    const { EmailSender } = await import('../senders/EmailSender');
    return new EmailSender(client, this);
  }

  /**
   * Create an EmailClient from stored settings
   * Retrieves credentials from smrt-secrets if credentialSecretId is set
   */
  async createClient() {
    const { getEmailClient } = await import('@happyvertical/email');
    let settings: Record<string, any>;

    // Use secrets integration if available
    if (this.credentialSecretId) {
      const { SecretService } = await import('@happyvertical/smrt-secrets');
      const secretService = await SecretService.create({ db: this.db });

      const secret = await secretService.retrieve(this.credentialSecretId);
      settings = JSON.parse(secret.value);
    } else {
      // Fallback to plain-text settings (DEPRECATED)
      settings = this.getSettings();
    }

    return await getEmailClient({
      type: this.providerType as ProviderType,
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
              ...this.childOptions(),
              accountId,
              name: folderName,
              path: folderName,
            });
            // initialize() binds the DB connection; without it save() throws
            // "Database accessed before initialization" and sync persists nothing.
            await folder.initialize();
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
              let email = existingEmail;
              if (!email) {
                email = new Email({
                  ...this.childOptions(),
                  accountId,
                });
                // Bind the DB connection before save() (existingEmail is already
                // initialized via the query that loaded it).
                await email.initialize();
              }

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
              email.body = msg.text || '';
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
   * Store credentials securely using smrt-secrets (email-specific)
   */
  override async setCredentials(
    credentials: Record<string, any>,
    options: {
      description?: string;
      category?: string;
    } = {},
  ): Promise<void> {
    const { SecretService } = await import('@happyvertical/smrt-secrets');
    const secretService = await SecretService.create({ db: this.db });

    const secretName = `email-account-${this.id}`;
    const secretValue = JSON.stringify(credentials);

    if (this.credentialSecretId) {
      await secretService.store(this.credentialSecretId, secretValue, {
        description: options.description || `IMAP credentials for ${this.name}`,
        category: options.category || 'email',
      });
    } else {
      await secretService.store(secretName, secretValue, {
        description: options.description || `IMAP credentials for ${this.name}`,
        category: options.category || 'email',
      });

      this.credentialSecretId = secretName;
      this.updatedAt = new Date();
      await this.save();
    }
  }

  /**
   * Sync all active email accounts (for job runner)
   *
   * NOTE: This is a class-wide operation, not per-instance. It syncs ALL active
   * accounts, ignoring `this` instance. It exists as an instance method because
   * the TaskRunner dispatches via `objectType: 'EmailAccount', method: 'syncAll'`
   * which requires an instance method signature.
   */
  async syncAll(
    args?: Record<string, unknown>,
  ): Promise<Map<string, { success: boolean; error?: Error }>> {
    const { EmailAccountCollection } = await import(
      '../collections/EmailAccountCollection'
    );
    const collection = await (EmailAccountCollection as any).create({
      db: this.db,
    });
    return collection.syncAll(args);
  }

  /**
   * Migrate from plain-text settings to secrets
   */
  async migrateToSecrets(): Promise<void> {
    if (this.credentialSecretId) {
      return;
    }

    const settings = this.getSettings();
    if (Object.keys(settings).length === 0) {
      return;
    }

    await this.setCredentials(settings, {
      description: `Migrated IMAP credentials for ${this.name}`,
    });
  }
}
