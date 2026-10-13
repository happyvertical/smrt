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
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AttachmentOptions } from '../types';

/**
 * Split an absolute path into its directory and file name, or return null for
 * a relative path. Plain string handling rather than `node:path`: the package
 * root must stay browser-reachable (the bundle-gate forbids `node:*` there).
 */
function splitAbsolutePath(
  filePath: string,
): { dir: string; base: string } | null {
  const absolute = filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
  if (!absolute) return null;
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
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
