/**
 * Attachment model - Generalized attachment for any message type
 *
 * Uses messageId instead of emailId for cross-type support.
 */

// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import {
  foreignKey,
  ObjectRegistry,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy/decorators';
import {
  assertHydratedMailAccess,
  assertMailDraftWrite,
  inMailSystemAccess,
  isMailWriteGated,
  learnMailAccessOptions,
} from '../access.js';
import {
  readStoredAttachmentFile,
  scopeAttachmentPath,
} from '../attachment-storage.js';
import type { AttachmentOptions } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Attachment extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Message')
  messageId = '';
  /**
   * The mail account this file belongs to. Copied from its message when the
   * attachment is saved, so per-account mail access can filter attachment
   * reads (lists, projections, counts) without a join. Null for rows saved
   * before the column existed: run `AttachmentCollection.backfillAccountIds()`.
   */
  @foreignKey('Account')
  accountId: string | null = null;
  filename = '';
  contentType = '';
  size = 0;
  contentId = ''; // For inline images (<img src="cid:...">)
  contentDisposition: 'attachment' | 'inline' = 'attachment';
  filePath = ''; // External file storage path
  sourceUrl = ''; // For non-email attachments (media URLs, etc.)

  // Timestamps
  createdAt = new Date();

  constructor(options: AttachmentOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.messageId !== undefined) this.messageId = options.messageId;
    if (options.accountId !== undefined)
      this.accountId = options.accountId || null;
    if (options.filename !== undefined) this.filename = options.filename;
    if (options.contentType !== undefined)
      this.contentType = options.contentType;
    if (options.size !== undefined) this.size = options.size;
    if (options.contentId !== undefined) this.contentId = options.contentId;
    if (options.contentDisposition !== undefined)
      this.contentDisposition = options.contentDisposition;
    if (options.filePath !== undefined) this.filePath = options.filePath;
    if (options.sourceUrl !== undefined) this.sourceUrl = options.sourceUrl;
    if (options.createdAt) this.createdAt = options.createdAt;
  }

  /**
   * Direct hydration (`new X({ id }).initialize()`, `loadRelated()`) bypasses
   * the collection read hooks, so the per-account mail policy is applied here
   * too: a row of an account closed to the principal never hydrates.
   */
  override async loadFromId() {
    await super.loadFromId();
    await assertHydratedMailAccess(this);
  }

  override async loadFromSlug() {
    await super.loadFromSlug();
    await assertHydratedMailAccess(this);
  }

  /**
   * An attachment is part of what its message will send, so writing one on
   * a message of an owned account that is not `sent` needs the same `draft`
   * scope as writing the message (see `Message.save()`), whichever route the
   * write takes. Deleting one on received mail stays open.
   *
   * Both the parent it is saved onto and the parent it is stored on count, so
   * an attachment cannot be moved on or off a draft without the scope.
   */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    // A stored path is relative to the attachment storage root and under the
    // message account's directory: refuse anything else before it is written,
    // and keep the normalised form.
    if (this.filePath) {
      this.filePath = scopeAttachmentPath(
        this.filePath,
        await this.currentAccountId(),
      );
    }
    await this.assertDraftParentWrite('save');
    return super.save(options);
  }

  override async delete(
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    await this.assertDraftParentWrite('delete');
    return super.delete(options);
  }

  /**
   * The account of the message this row is stored on now, read from the
   * stored message (never from the row's own `accountId`), or null.
   */
  private async currentAccountId(): Promise<string | null> {
    if (!this.messageId) return null;
    try {
      const { MessageCollection } = await import(
        '../collections/MessageCollection.js'
      );
      const messages = await MessageCollection.create(this.options as never);
      const parent = (await this.db.get(messages.tableName, {
        id: this.messageId,
      })) as Record<string, unknown> | null;
      return (parent?.account_id as string | null) || null;
    } catch {
      return null;
    }
  }

  /**
   * Trusted system work and non-draft parents pass. Unlike the message check
   * this runs before the write, not inside its transaction: the attachment
   * save interceptor builds collections from the instance's options, and
   * inside a transaction those would register the transaction's handle as a
   * policy database.
   */
  private async assertDraftParentWrite(
    write: 'save' | 'delete',
  ): Promise<void> {
    learnMailAccessOptions(this.options);
    if (inMailSystemAccess()) return;
    const parentIds = new Set<string>();
    if (this.messageId) parentIds.add(this.messageId);
    if (this.id) {
      const stored = await this.getCanonicalPersistedRow({ id: this.id });
      if (typeof stored?.message_id === 'string' && stored.message_id) {
        parentIds.add(stored.message_id);
      }
    }
    // A new attachment is written over the stored row that carries its slug
    // (its own, or the one the save derives from its id): that row's parent is
    // the one it changes.
    const slug = this.isPersisted ? '' : this.slug || (await this.getSlug());
    if (slug) {
      const columns = ObjectRegistry.getConflictColumns(
        this.getResolvedQualifiedName(),
      );
      if (columns.includes('slug')) {
        for (const keyed of await this.getCanonicalPersistedRows({
          slug,
        })) {
          if (typeof keyed.message_id === 'string' && keyed.message_id) {
            parentIds.add(keyed.message_id);
          }
        }
      }
    }
    if (!parentIds.size) return;
    const { MessageCollection } = await import(
      '../collections/MessageCollection.js'
    );
    const messages = await MessageCollection.create(this.options as never);
    const accountIds: Array<string | null> = [];
    for (const id of parentIds) {
      const parent = (await this.db.get(messages.tableName, { id })) as Record<
        string,
        unknown
      > | null;
      if (parent && isMailWriteGated(parent, write)) {
        accountIds.push((parent.account_id as string | null) ?? null);
      }
    }
    await assertMailDraftWrite(accountIds, this.options);
  }

  /**
   * Get the message this attachment belongs to
   */
  async getMessage() {
    if (!this.messageId) return null;

    const { MessageCollection } = await import(
      '../collections/MessageCollection'
    );
    const collection = await MessageCollection.create(this.options);

    return await collection.get({ id: this.messageId });
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
   * Check if attachment is inline (embedded in message body)
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
   * Read the stored file's bytes, or null when the row has no file or the
   * file is missing or unreadable.
   *
   * `filePath` is relative to the root set with `configureAttachmentStorage`
   * and must lie under `<accountId>/` of the message's current account.
   * Throws `AttachmentStorageError` when no root is configured, or when the
   * stored path (or a symlink under it) leaves the root or the account's
   * directory; this includes rows stored before the root existed. The bytes are read
   * raw: decoding a PDF as UTF-8 corrupts it (#3808).
   */
  async readContent(): Promise<Buffer | null> {
    if (!this.filePath) return null;
    return readStoredAttachmentFile(
      this.filePath,
      await this.currentAccountId(),
    );
  }
}
