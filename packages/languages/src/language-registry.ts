import type {
  LanguageStringDefinition,
  LanguageStringDefinitionInput,
} from './types.js';
import { computeSourceHash, normalizeLocale } from './utils.js';

declare global {
  // eslint-disable-next-line no-var
  var __smrtLanguageRegistry:
    | Map<string, Map<string, LanguageStringDefinition>>
    | undefined;
}

function getRegistry(): Map<string, Map<string, LanguageStringDefinition>> {
  if (!globalThis.__smrtLanguageRegistry) {
    globalThis.__smrtLanguageRegistry = new Map();
  }
  return globalThis.__smrtLanguageRegistry;
}

function buildIndex(
  key: string,
  locale: string,
): { key: string; locale: string } {
  return { key, locale: normalizeLocale(locale) };
}

export const LanguageRegistry = {
  register(input: LanguageStringDefinitionInput): LanguageStringDefinition {
    if (!input.key || input.key.trim() === '') {
      throw new Error('Language string definitions require a non-empty key');
    }
    if (!input.locale || input.locale.trim() === '') {
      throw new Error(
        `Language string "${input.key}" requires a non-empty locale`,
      );
    }
    if (typeof input.template !== 'string') {
      throw new Error(
        `Language string "${input.key}" template must be a string`,
      );
    }

    const { key, locale } = buildIndex(input.key, input.locale);
    const definition: LanguageStringDefinition = {
      key,
      locale,
      template: input.template,
      sourceHash: computeSourceHash(input.template),
    };

    const registry = getRegistry();
    let byLocale = registry.get(key);
    if (!byLocale) {
      byLocale = new Map();
      registry.set(key, byLocale);
    }

    const existing = byLocale.get(locale);
    if (existing) {
      if (existing.template !== definition.template) {
        throw new Error(
          `Language string "${key}" is already registered for locale "${locale}" with a different template`,
        );
      }
      return existing;
    }

    byLocale.set(locale, definition);
    return definition;
  },

  get(key: string, locale: string): LanguageStringDefinition | undefined {
    return getRegistry().get(key)?.get(normalizeLocale(locale));
  },

  has(key: string, locale: string): boolean {
    return Boolean(this.get(key, locale));
  },

  hasKey(key: string): boolean {
    return getRegistry().has(key);
  },

  /** Return the locales that have a registered code default for the given key. */
  getLocalesForKey(key: string): string[] {
    const byLocale = getRegistry().get(key);
    return byLocale ? Array.from(byLocale.keys()) : [];
  },

  /** All registered (key, locale, template) triples. Used by the batch translator. */
  getAll(): LanguageStringDefinition[] {
    const all: LanguageStringDefinition[] = [];
    for (const byLocale of getRegistry().values()) {
      for (const definition of byLocale.values()) {
        all.push(definition);
      }
    }
    return all;
  },

  /** Distinct keys currently registered. */
  getKeys(): string[] {
    return Array.from(getRegistry().keys());
  },

  clear(): void {
    getRegistry().clear();
  },
};

export function defineLanguageString(
  input: LanguageStringDefinitionInput,
): LanguageStringDefinition {
  return LanguageRegistry.register(input);
}
