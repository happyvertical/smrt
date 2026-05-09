import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { invalidateLanguageCache } from '../cache.js';
import type { LanguageOverrideOptions } from '../types.js';
import { normalizeLocale } from '../utils.js';

export interface LanguageOverrideCtorOptions
  extends SmrtObjectOptions,
    LanguageOverrideOptions {}

@smrt({
  tableName: '_smrt_language_overrides',
  conflictColumns: ['key', 'locale', 'context'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: {
    include: ['list', 'get', 'create', 'update', 'delete', 'approve'],
  },
  mcp: { include: [] },
})
export class LanguageOverride extends SmrtObject {
  @field({ required: true })
  key: string = '';

  @field({ required: true })
  locale: string = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', required: true })
  template: string = '';

  /** True when this row was produced by the AI translation job. */
  @field({ type: 'boolean', required: true, default: false })
  auto_generated: boolean = false;

  /** sha256 of the source template at translation time, for re-translation gating. */
  @field({ type: 'text', nullable: true })
  source_hash: string | null = null;

  /** AI model identifier (null for human-edited rows). */
  @field({ type: 'text', nullable: true })
  ai_model: string | null = null;

  /** ISO timestamp marking admin review of an auto-generated row. */
  @field({ type: 'text', nullable: true })
  reviewed_at: string | null = null;

  /** User ID of the reviewer. */
  @field({ type: 'text', nullable: true })
  reviewed_by: string | null = null;

  constructor(options: LanguageOverrideCtorOptions = {}) {
    super(options);

    if (options.key !== undefined) this.key = options.key;
    if (options.locale !== undefined)
      this.locale = normalizeLocale(options.locale);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.template !== undefined) this.template = options.template;
    if (options.auto_generated !== undefined) {
      this.auto_generated = options.auto_generated;
    }
    if (options.source_hash !== undefined)
      this.source_hash = options.source_hash;
    if (options.ai_model !== undefined) this.ai_model = options.ai_model;
    if (options.reviewed_at !== undefined)
      this.reviewed_at = options.reviewed_at;
    if (options.reviewed_by !== undefined)
      this.reviewed_by = options.reviewed_by;
  }

  override async save(): Promise<this> {
    if (!this.key || this.key.trim() === '') {
      throw new Error('LanguageOverride.key is required');
    }
    if (!this.locale || this.locale.trim() === '') {
      throw new Error('LanguageOverride.locale is required');
    }
    if (typeof this.template !== 'string') {
      throw new Error('LanguageOverride.template must be a string');
    }

    this.locale = normalizeLocale(this.locale);
    // `context` is the conflictColumn-friendly scope: 'app' for nullable tenant,
    // tenantId otherwise. Mirrors the prompt-override convention.
    this.context = this.tenantId ?? '__app__';

    const previousIdentity = await this.getPersistedIdentity();
    const result = await super.save();

    if (
      previousIdentity &&
      (previousIdentity.key !== this.key ||
        previousIdentity.locale !== this.locale ||
        previousIdentity.tenantId !== this.tenantId)
    ) {
      invalidateLanguageCache(
        previousIdentity.key,
        previousIdentity.locale,
        previousIdentity.tenantId,
        this.db,
      );
    }
    invalidateLanguageCache(this.key, this.locale, this.tenantId, this.db);
    return result;
  }

  override async delete(): Promise<void> {
    const key = this.key;
    const locale = this.locale;
    const tenantId = this.tenantId;
    await super.delete();
    invalidateLanguageCache(key, locale, tenantId, this.db);
  }

  /**
   * Mark this auto-generated row as reviewed by an admin. Useful for the
   * admin review queue surfaced via `smrt languages approve <id>`.
   */
  async approve(reviewerId: string): Promise<this> {
    this.reviewed_at = new Date().toISOString();
    this.reviewed_by = reviewerId;
    return this.save();
  }

  private async getPersistedIdentity(): Promise<{
    key: string;
    locale: string;
    tenantId: string | null;
  } | null> {
    if (!this.id) {
      return null;
    }

    const existing = await this.db.get(this.tableName, { id: this.id });
    if (!existing) {
      return null;
    }

    const row = existing as Record<string, unknown>;
    return {
      key: String(row.key ?? this.key),
      locale: String(row.locale ?? this.locale),
      tenantId:
        row.tenantId !== undefined
          ? (row.tenantId as string | null)
          : (((row.tenant_id as string | null | undefined) ?? null) as
              | string
              | null),
    };
  }
}

export type { LanguageOverrideOptions } from '../types.js';
