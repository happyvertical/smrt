import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ContentFeedFormat } from './content-feed-parser';

export type ContentFeedSourceStatus =
  | 'active'
  | 'paused'
  | 'error'
  | 'archived';

export interface ContentFeedSourceOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  name?: string;
  feedUrl?: string;
  homepageUrl?: string | null;
  format?: ContentFeedFormat | null;
  status?: ContentFeedSourceStatus;
  defaultCategory?: string | null;
  sourceGroup?: string | null;
  pollIntervalMinutes?: number;
  etag?: string | null;
  lastModified?: string | null;
  lastFetchedAt?: Date | string | null;
  lastSuccessAt?: Date | string | null;
  lastError?: string | null;
  metadata?: Record<string, any> | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

const SOURCE_STATUSES = new Set<ContentFeedSourceStatus>([
  'active',
  'paused',
  'error',
  'archived',
]);

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseMetadata(
  value: Record<string, any> | string | undefined,
): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return structuredClone(value);

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePollIntervalMinutes(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 15;
}

function normalizeStatus(value: unknown): ContentFeedSourceStatus {
  return typeof value === 'string' &&
    SOURCE_STATUSES.has(value as ContentFeedSourceStatus)
    ? (value as ContentFeedSourceStatus)
    : 'active';
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_feed_sources',
  conflictColumns: ['tenant_id', 'feed_url'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class ContentFeedSource extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ required: true })
  name = '';

  @field({ required: true })
  feedUrl = '';

  homepageUrl: string | null = null;
  format: ContentFeedFormat | null = null;
  @field({ type: 'text', required: true, default: 'active' })
  status: ContentFeedSourceStatus = 'active';
  defaultCategory: string | null = null;
  sourceGroup: string | null = null;
  pollIntervalMinutes = 15;
  etag: string | null = null;
  lastModified: string | null = null;
  lastFetchedAt: Date | null = null;
  lastSuccessAt: Date | null = null;
  lastError: string | null = null;
  metadata: Record<string, any> = {};
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentFeedSourceOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.feedUrl !== undefined) this.feedUrl = options.feedUrl;
    if (options.homepageUrl !== undefined)
      this.homepageUrl = options.homepageUrl;
    if (options.format !== undefined) this.format = options.format;
    if (options.status !== undefined)
      this.status = normalizeStatus(options.status);
    if (options.defaultCategory !== undefined)
      this.defaultCategory = options.defaultCategory;
    if (options.sourceGroup !== undefined)
      this.sourceGroup = options.sourceGroup;
    if (options.pollIntervalMinutes !== undefined) {
      this.pollIntervalMinutes = normalizePollIntervalMinutes(
        options.pollIntervalMinutes,
      );
    }
    if (options.etag !== undefined) this.etag = options.etag;
    if (options.lastModified !== undefined)
      this.lastModified = options.lastModified;
    if (options.lastFetchedAt !== undefined)
      this.lastFetchedAt = parseDate(options.lastFetchedAt);
    if (options.lastSuccessAt !== undefined)
      this.lastSuccessAt = parseDate(options.lastSuccessAt);
    if (options.lastError !== undefined) this.lastError = options.lastError;
    if (options.metadata !== undefined)
      this.metadata = parseMetadata(options.metadata);
    if (options.createdAt !== undefined)
      this.createdAt = parseDate(options.createdAt) ?? new Date();
    if (options.updatedAt !== undefined)
      this.updatedAt = parseDate(options.updatedAt) ?? new Date();
  }

  getMetadata(): Record<string, any> {
    return structuredClone(this.metadata);
  }

  setMetadata(metadata: Record<string, any>): void {
    this.metadata = structuredClone(metadata);
    this.updatedAt = new Date();
  }

  markFetchStarted(at = new Date()): void {
    this.lastFetchedAt = at;
    this.updatedAt = at;
  }

  markFetchSucceeded(
    at = new Date(),
    headers: { etag?: string | null; lastModified?: string | null } = {},
  ): void {
    this.status = 'active';
    this.lastFetchedAt = at;
    this.lastSuccessAt = at;
    this.lastError = null;
    if (headers.etag !== undefined) this.etag = headers.etag;
    if (headers.lastModified !== undefined)
      this.lastModified = headers.lastModified;
    this.updatedAt = at;
  }

  markFetchFailed(error: unknown, at = new Date()): void {
    this.status = 'error';
    this.lastFetchedAt = at;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.updatedAt = at;
  }

  protected override transformJSON(
    json: Record<string, any>,
  ): Record<string, unknown> {
    return {
      ...json,
      tenantId: this.tenantId,
      name: this.name,
      feedUrl: this.feedUrl,
      homepageUrl: this.homepageUrl,
      format: this.format,
      status: this.status,
      defaultCategory: this.defaultCategory,
      sourceGroup: this.sourceGroup,
      pollIntervalMinutes: this.pollIntervalMinutes,
      etag: this.etag,
      lastModified: this.lastModified,
      lastFetchedAt: this.lastFetchedAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastError: this.lastError,
      metadata: this.metadata,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
