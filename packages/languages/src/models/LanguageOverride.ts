import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { invalidateLanguageCache } from '../cache.js';
import type { LanguageOverrideOptions } from '../types.js';
import { normalizeLocale } from '../utils.js';

type LanguageTransactionHandle = DatabaseInterface & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

export interface LanguageOverrideCtorOptions
  extends SmrtObjectOptions,
    LanguageOverrideOptions {}

@smrt({
  tableName: '_smrt_language_overrides',
  conflictColumns: ['key', 'locale', 'context'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: {
    include: ['list', 'get', 'create', 'update', 'delete', 'approve'],
    // approve is an admin review action invoked in-process via the CLI;
    // it intentionally isn't exposed over HTTP today.
    skipApiCheck: true,
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
    // `context` is the conflictColumn-friendly scope: '__app__' for nullable
    // tenant, tenantId otherwise. Mirrors the prompt-override convention.
    this.context = this.tenantId ?? '__app__';

    const previousIdentity = await this.getPersistedIdentity();
    const identityChanged =
      !!previousIdentity &&
      (previousIdentity.key !== this.key ||
        previousIdentity.locale !== this.locale ||
        previousIdentity.tenantId !== this.tenantId);

    // Persistence upserts on `(key, locale, context)`, so changing any of
    // those on an existing row makes a plain `super.save()` write the old
    // primary key under a new conflict identity — that hits the PK
    // constraint instead of moving the override. Use the same
    // delete-then-insert dance as PromptOverride: prefer a transaction when
    // the driver supports it; otherwise stage a replacement row first and
    // delete the old one only after the new one is durable.
    const result =
      identityChanged && previousIdentity
        ? await this.saveAfterIdentityChange()
        : await super.save();

    if (identityChanged && previousIdentity) {
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

  private async saveAfterIdentityChange(): Promise<this> {
    if (typeof this.db.beginTransaction === 'function') {
      return this.saveAfterIdentityChangeInTransaction();
    }
    return this.saveAfterIdentityChangeWithDeferredDelete();
  }

  private async saveAfterIdentityChangeInTransaction(): Promise<this> {
    const originalDb = this._db;
    const originalOptionsDb = this.options.db;
    const tx = (await this.db.beginTransaction?.()) as
      | LanguageTransactionHandle
      | undefined;

    if (!tx) {
      return this.saveAfterIdentityChangeWithDeferredDelete();
    }

    try {
      this._db = tx;
      this.options.db = tx;
      await super.delete();
      const result = await super.save();
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // Preserve the original save error; rollback failures are secondary.
      }
      throw error;
    } finally {
      this._db = originalDb;
      this.options.db = originalOptionsDb;
    }
  }

  private async saveAfterIdentityChangeWithDeferredDelete(): Promise<this> {
    const previousId = this.id;
    if (!previousId) {
      return super.save();
    }

    const replacementId = crypto.randomUUID();
    let replacementSaved = false;
    this.id = replacementId;

    try {
      const result = await super.save();
      replacementSaved = true;
      await this.db.delete(this.tableName, { id: previousId });
      return result;
    } catch (error) {
      if (replacementSaved) {
        try {
          await this.db.delete(this.tableName, { id: replacementId });
        } catch {
          // Best effort cleanup keeps the original row as the source of truth.
        }
      }
      this.id = previousId;
      throw error;
    }
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
