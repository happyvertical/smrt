import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ContentVersionKind } from './content-governance';
import { normalizeContentTransparency } from './content-transparency';

/**
 * Shape of the loosely-structured `metadata` JSON bag stored on a content
 * version. Known fields are typed; unrecognized keys remain accessible via the
 * index signature.
 */
export interface ContentVersionMetadata {
  /**
   * Fingerprint of the snapshot captured for the latest publication version,
   * used to detect post-publication drift.
   */
  publicationSnapshotFingerprint?: string;
  [key: string]: unknown;
}

export interface ContentVersionOptions extends SmrtObjectOptions {
  contentId?: string;
  version?: number;
  kind?: ContentVersionKind;
  title?: string;
  description?: string;
  body?: string;
  status?: string;
  summary?: string;
  snapshot?: string | Record<string, unknown>;
  metadata?: string | Record<string, unknown>;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_versions',
  conflictColumns: ['content_id', 'version'],
  api: {
    include: ['list', 'get', 'create', 'getTransparencyAction'],
    routes: {
      getTransparencyAction: { method: 'GET', path: 'transparency' },
    },
  },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class ContentVersion extends SmrtObject {
  @foreignKey('Content', { required: true })
  contentId = '';

  version = 1;
  kind: ContentVersionKind = 'manual';
  title = '';
  description = '';
  body = '';
  status = 'draft';
  summary = '';
  snapshot = '{}';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentVersionOptions = {}) {
    super(options);
    if (options.contentId) this.contentId = options.contentId;
    if (options.version !== undefined) this.version = options.version;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.title !== undefined) this.title = options.title;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.body !== undefined) this.body = options.body;
    if (options.status !== undefined) this.status = options.status;
    if (options.summary !== undefined) this.summary = options.summary;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;

    if (options.snapshot !== undefined) {
      this.snapshot =
        typeof options.snapshot === 'string'
          ? options.snapshot
          : JSON.stringify(options.snapshot);
    }

    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getSnapshot(): Record<string, unknown> {
    try {
      return this.snapshot ? JSON.parse(this.snapshot) : {};
    } catch {
      return {};
    }
  }

  getMetadata(): ContentVersionMetadata {
    try {
      return this.metadata ? JSON.parse(this.metadata) : {};
    } catch {
      return {};
    }
  }

  getTransparency() {
    const metadata = this.getMetadata();
    const snapshot = this.getSnapshot();

    return normalizeContentTransparency(metadata.transparency, {
      snapshotKind: this.kind === 'publication' ? 'published' : 'preview',
      contentId: this.contentId || (snapshot.contentId as string) || null,
      currentContentStatus:
        this.status || (snapshot.status as string) || 'draft',
      publicationVersion: {
        id: (this.id as string) || null,
        version: this.version ?? null,
        kind: this.kind || null,
        summary: this.summary || '',
        createdAt:
          this.createdAt instanceof Date ? this.createdAt.toISOString() : null,
      },
    });
  }

  async getTransparencyAction() {
    return this.getTransparency();
  }
}
