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
  importOptionalDependency,
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
  isUnsentDraft,
  learnMailAccessOptions,
} from '../access.js';
import type { AttachmentOptions } from '../types';

/**
 * Split an absolute path into its directory and file name, or return null for
 * a relative path. Plain string handling rather than `node:path`: the package
 * root must stay browser-reachable (the bundle-gate forbids `node:*` there).
 */
function splitAbsolutePath(
  filePath: string,
): { dir: string; base: string } | null {
  // A backslash separates segments only in a Windows path; in a POSIX path it
  // is an ordinary filename character.
  const windows = /^[A-Za-z]:[\\/]/.test(filePath);
  if (!windows && !filePath.startsWith('/')) return null;
  const cut = windows
    ? Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    : filePath.lastIndexOf('/');
  const dir = filePath.slice(0, cut) || filePath.slice(0, cut + 1);
  return { dir, base: filePath.slice(cut + 1) };
}

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
   * An attachment is part of what its message will send, so writing one on an
   * unsent email draft of an owned account needs the same `draft` scope as
   * writing the draft (see `Message.save()`), whichever route the write takes.
   * Both the parent it is saved onto and the parent it is stored on count, so
   * an attachment cannot be moved on or off a draft without the scope.
   */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await this.assertDraftParentWrite();
    return super.save(options);
  }

  override async delete(
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    await this.assertDraftParentWrite();
    return super.delete(options);
  }

  /**
   * Trusted system work and non-draft parents pass. Unlike the message check
   * this runs before the write, not inside its transaction: the attachment
   * save interceptor builds collections from the instance's options, and
   * inside a transaction those would register the transaction's handle as a
   * policy database.
   */
  private async assertDraftParentWrite(): Promise<void> {
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
    // A new attachment with an explicit slug is written over the stored row
    // with that slug: that row's parent is the one it changes.
    if (!this.isPersisted && this.slug) {
      const columns = ObjectRegistry.getConflictColumns(
        this.getResolvedQualifiedName(),
      );
      if (columns.includes('slug')) {
        for (const keyed of await this.getCanonicalPersistedRows({
          slug: this.slug,
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
      if (parent && isUnsentDraft(parent.send_status, parent.is_draft)) {
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
   * Read file content (if stored externally)
   *
   * The files SDK is loaded through core's bundler-invisible optional-import
   * boundary so it never enters provider-neutral consumer bundles (#1979).
   * Absence of the SDK at runtime degrades to the existing null contract.
   *
   * The local provider joins every path onto its base path (the process cwd
   * by default), so an absolute `filePath` is rooted at its own directory, and
   * the bytes are read raw: decoding a PDF as UTF-8 corrupts it (#3808).
   */
  async readContent(): Promise<Buffer | null> {
    if (!this.filePath) return null;

    try {
      const { getFilesystem, initializeProviders } =
        (await importOptionalDependency(
          '@happyvertical/files',
          "Import '@happyvertical/smrt-core/filesystem' (or '@happyvertical/smrt-assets/filesystem') during server startup to read externally-stored attachments in bundled builds.",
        )) as typeof import('@happyvertical/files');
      // The SDK registers its providers asynchronously on import; make the
      // local one available before asking for it.
      await initializeProviders?.();
      const split = splitAbsolutePath(this.filePath);
      const files = await getFilesystem(
        split ? { type: 'local', basePath: split.dir } : { type: 'local' },
      );
      const data = await files.read(split ? split.base : this.filePath, {
        raw: true,
      });
      return data instanceof Buffer ? data : Buffer.from(data);
    } catch {
      return null;
    }
  }
}
