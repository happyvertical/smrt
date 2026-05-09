import { SmrtCollection } from '@happyvertical/smrt-core';
import { LanguageOverride } from '../models/LanguageOverride.js';
import { normalizeLocale } from '../utils.js';

export class LanguageOverrideCollection extends SmrtCollection<LanguageOverride> {
  static readonly _itemClass = LanguageOverride;

  /**
   * Look up the app-level (tenantId = null) override for a (key, locale) pair.
   * App-level rows hold AI auto-translations and ops-curated app-wide strings.
   */
  async getAppOverride(
    key: string,
    locale: string,
  ): Promise<LanguageOverride | null> {
    const items = await this.list({
      where: { key, locale: normalizeLocale(locale), tenantId: null },
    });
    return items[0] ?? null;
  }

  async getTenantOverride(
    key: string,
    locale: string,
    tenantId: string,
  ): Promise<LanguageOverride | null> {
    const items = await this.list({
      where: { key, locale: normalizeLocale(locale), tenantId },
    });
    return items[0] ?? null;
  }

  /**
   * Convenience helper for the resolver: returns the app and (optional) tenant
   * override rows for a (key, locale).
   */
  async getResolutionLayers(
    key: string,
    locale: string,
    tenantId?: string | null,
  ): Promise<{
    app: LanguageOverride | null;
    tenant: LanguageOverride | null;
  }> {
    const [app, tenant] = await Promise.all([
      this.getAppOverride(key, locale),
      tenantId != null
        ? this.getTenantOverride(key, locale, tenantId)
        : Promise.resolve(null),
    ]);
    return { app, tenant };
  }

  /** All overrides for a tenant (used to build the AI translation glossary). */
  async listTenantOverrides(tenantId: string): Promise<LanguageOverride[]> {
    return this.list({ where: { tenantId } });
  }

  /** Auto-generated overrides that no admin has approved yet. */
  async listUnreviewedAutoTranslations(
    options: { locale?: string; limit?: number } = {},
  ): Promise<LanguageOverride[]> {
    const where: Record<string, unknown> = {
      auto_generated: true,
      reviewed_at: null,
    };
    if (options.locale) {
      where.locale = normalizeLocale(options.locale);
    }
    return this.list({
      where,
      orderBy: 'createdAt ASC',
      limit: options.limit,
    });
  }
}
