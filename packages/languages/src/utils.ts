import { createHash } from 'node:crypto';
import type { LanguageVariables } from './types.js';

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Stable hash used to gate auto-translation re-runs against a specific source. */
export function computeSourceHash(template: string): string {
  return `sha256:${createHash('sha256').update(template, 'utf8').digest('hex')}`;
}

/** Normalize a BCP-47 tag to lowercase region-and-script segments. */
export function normalizeLocale(locale: string): string {
  if (!locale) return '';
  const trimmed = locale.trim();
  if (!trimmed) return '';
  // Lowercase language; uppercase region for consistent matching.
  const [language, ...rest] = trimmed.split('-');
  if (rest.length === 0) {
    return language.toLowerCase();
  }
  return [
    language.toLowerCase(),
    ...rest.map((part) => part.toUpperCase()),
  ].join('-');
}

/**
 * Build the locale fallback chain for a requested locale.
 *
 * Example: `fr-CA` with default `en` → `['fr-CA', 'fr', 'en']`.
 * Duplicates and empty segments are removed.
 */
export function buildLocaleFallbackChain(
  requested: string,
  defaultLocale: string,
): string[] {
  const chain: string[] = [];
  const push = (value: string) => {
    const normalized = normalizeLocale(value);
    if (normalized && !chain.includes(normalized)) {
      chain.push(normalized);
    }
  };

  if (requested) {
    let current = normalizeLocale(requested);
    while (current) {
      push(current);
      const idx = current.lastIndexOf('-');
      if (idx === -1) break;
      current = current.slice(0, idx);
    }
  }

  if (defaultLocale) {
    push(defaultLocale);
  }

  return chain;
}

/** Render `{var}` placeholders. Missing variables collapse to empty strings. */
export function renderTemplate(
  template: string,
  variables?: LanguageVariables,
): string {
  if (!variables || Object.keys(variables).length === 0) {
    return template;
  }

  return template.replace(/\{([^{}]+)\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const value = variables[key];

    if (value === undefined || value === null) {
      return '';
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value) || isPlainObject(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }

    return String(value);
  });
}

/** Deterministic translation-job ID — used for stampede protection. */
export function buildTranslationJobId(
  key: string,
  targetLocale: string,
): string {
  return `smrt-languages.translate:${key}:${normalizeLocale(targetLocale)}`;
}
