import type { SmrtClassOptions } from '@happyvertical/smrt-core';

/** A registered code default for a single (key, locale) pair. */
export interface LanguageStringDefinitionInput {
  key: string;
  locale: string;
  template: string;
}

export interface LanguageStringDefinition {
  key: string;
  locale: string;
  template: string;
  /** sha256 of the template at registration time, used for re-translation gating */
  sourceHash: string;
}

/**
 * Per-package config bag, read via `getPackageConfig('languages', ...)`.
 *
 * `overrides[key][locale]` is a plain string template that takes precedence over
 * code defaults for that (key, locale) pair. It is the file-config layer in the
 * 5-layer resolution chain.
 */
export interface LanguagesPackageConfig {
  /** Default locale used when none is supplied at resolve-time. Defaults to 'en'. */
  defaultLocale?: string;
  /** When set, AI auto-translation jobs are only enqueued for these locales. */
  supportedLocales?: string[];
  /** Daily cap on AI translation jobs per tenant (null = no cap). */
  translationBudgetPerTenantPerDay?: number | null;
  /** File-config overrides, keyed by (key)(locale). */
  overrides?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

export type LanguageVariables = Record<string, unknown>;

export interface ResolveLanguageStringOptions {
  db?: SmrtClassOptions['db'];
  tenantId?: string | null;
  locale?: string;
  /** Variables substituted into `{var}` placeholders. */
  vars?: LanguageVariables;
  /** Optional per-call override for the rendered template (highest precedence). */
  overrides?: { template?: string };
  /**
   * When `true`, throw if the resolution chain finishes without producing a
   * template. When `false` (default), return the key as the rendered string and
   * enqueue an AI translation job for the missing (key, locale).
   */
  strict?: boolean;
}

export interface ResolvedLanguageString {
  key: string;
  locale: string;
  /** The fully-rendered string with variables substituted. */
  text: string;
  /** The raw template that produced `text`. */
  template: string;
  /** Locale that actually produced the template (may differ from `locale` after fallback). */
  resolvedFromLocale: string;
  /**
   * `'code' | 'config' | 'app' | 'tenant' | 'runtime'`. `'fallback'` indicates
   * no exact match was found and a fallback locale was used.
   */
  source:
    | 'code'
    | 'config'
    | 'app'
    | 'tenant'
    | 'runtime'
    | 'fallback'
    | 'missing';
}

export interface LanguageCacheValue {
  key: string;
  locale: string;
  template: string;
  source: ResolvedLanguageString['source'];
  resolvedFromLocale: string;
}

export interface LanguageOverrideOptions {
  key?: string;
  locale?: string;
  tenantId?: string | null;
  template?: string;
  auto_generated?: boolean;
  source_hash?: string | null;
  ai_model?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
}

/** Payload pushed to the smrt-jobs translation handler. */
export interface TranslationJobPayload {
  key: string;
  sourceLocale: string;
  sourceTemplate: string;
  sourceHash: string;
  targetLocale: string;
  tenantId?: string | null;
  /** Optional model override; defaults to config / @happyvertical/ai default. */
  model?: string;
  [key: string]: unknown;
}
