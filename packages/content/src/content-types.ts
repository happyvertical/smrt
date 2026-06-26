/**
 * Content subclasses for STI (Single Table Inheritance)
 *
 * These classes inherit from Content and automatically use the shared
 * contents table with _meta_type discriminator.
 */

import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { Content, type ContentOptions } from './content';

/**
 * Article content type
 *
 * Represents editorial content like blog posts, news articles, and written pieces.
 */
@smrt({
  tableStrategy: 'sti',
  api: false,
  mcp: false,
  cli: false,
})
export class Article extends Content {
  constructor(options: ContentOptions = {}) {
    super(options);
    // Article-specific initialization can go here
  }
}

/**
 * ContentDocument content type
 *
 * Represents structured documents like PDFs, reports, and technical documentation.
 */
@smrt({
  tableStrategy: 'sti',
  api: false,
  mcp: false,
  cli: false,
})
export class ContentDocument extends Content {
  constructor(options: ContentOptions = {}) {
    super(options);
    // ContentDocument-specific initialization can go here
  }
}

export interface MirrorOptions extends ContentOptions {
  feedSourceId?: string | null;
  sourceGuid?: string | null;
  sourceName?: string | null;
  sourceHomepageUrl?: string | null;
  externalUrl?: string | null;
  originalPublishedAt?: Date | string | null;
  dedupeKey?: string | null;
}

function parseOptionalDate(
  value: Date | string | null | undefined,
): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Mirror content type
 *
 * Represents mirrored/cached content from external feed or web sources.
 */
@smrt({
  tableStrategy: 'sti',
  api: false,
  mcp: false,
  cli: false,
})
export class Mirror extends Content {
  @foreignKey('ContentFeedSource')
  feedSourceId: string | null = null;
  sourceGuid: string | null = null;
  sourceName: string | null = null;
  sourceHomepageUrl: string | null = null;
  externalUrl: string | null = null;
  originalPublishedAt: Date | null = null;
  dedupeKey: string | null = null;

  constructor(options: MirrorOptions = {}) {
    super(options);
    if (options.feedSourceId !== undefined)
      this.feedSourceId = options.feedSourceId;
    if (options.sourceGuid !== undefined) this.sourceGuid = options.sourceGuid;
    if (options.sourceName !== undefined) this.sourceName = options.sourceName;
    if (options.sourceHomepageUrl !== undefined)
      this.sourceHomepageUrl = options.sourceHomepageUrl;
    if (options.externalUrl !== undefined)
      this.externalUrl = options.externalUrl;
    if (options.originalPublishedAt !== undefined) {
      this.originalPublishedAt = parseOptionalDate(options.originalPublishedAt);
    }
    if (options.dedupeKey !== undefined) this.dedupeKey = options.dedupeKey;
  }

  protected override transformJSON(json: Record<string, unknown>) {
    return {
      ...json,
      feedSourceId: this.feedSourceId,
      sourceGuid: this.sourceGuid,
      sourceName: this.sourceName,
      sourceHomepageUrl: this.sourceHomepageUrl,
      externalUrl: this.externalUrl,
      originalPublishedAt: this.originalPublishedAt?.toISOString() ?? null,
      dedupeKey: this.dedupeKey,
    };
  }
}
