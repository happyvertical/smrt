import type { LanguageOverride } from './models/LanguageOverride.js';
import { normalizeLocale } from './utils.js';

/**
 * Build a glossary string suitable for inclusion in an AI translation prompt.
 *
 * Pulls the tenant's existing language overrides for the source/target locales
 * and renders them as a concise list of "source → target" pairs, restricted to
 * keys that actually have both sides. The intent is "make AI auto-translations
 * match tenant voice", not bulk dump every override.
 *
 * Returns an empty string when there is nothing useful to add.
 */
export function buildTenantGlossary(
  overrides: LanguageOverride[],
  options: { sourceLocale: string; targetLocale: string; max?: number },
): string {
  const sourceLocale = normalizeLocale(options.sourceLocale);
  const targetLocale = normalizeLocale(options.targetLocale);
  const max = options.max ?? 25;

  const sourceByKey = new Map<string, string>();
  const targetByKey = new Map<string, string>();

  for (const override of overrides) {
    if (!override.template) continue;
    const locale = normalizeLocale(override.locale);
    if (locale === sourceLocale) {
      sourceByKey.set(override.key, override.template);
    } else if (locale === targetLocale) {
      targetByKey.set(override.key, override.template);
    }
  }

  const pairs: string[] = [];
  for (const [key, source] of sourceByKey.entries()) {
    const target = targetByKey.get(key);
    if (target) {
      pairs.push(`- "${source}" → "${target}"`);
      if (pairs.length >= max) break;
    }
  }

  return pairs.join('\n');
}
