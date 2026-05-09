import { getPackageConfig } from '@happyvertical/smrt-config';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import {
  getCachedLanguage,
  invalidateLanguageCache,
  setCachedLanguage,
} from './cache.js';
import { LanguageOverrideCollection } from './collections/LanguageOverrideCollection.js';
import { LanguageRegistry } from './language-registry.js';
import type {
  LanguageCacheValue,
  LanguagesPackageConfig,
  ResolvedLanguageString,
  ResolveLanguageStringOptions,
} from './types.js';
import {
  buildLocaleFallbackChain,
  normalizeLocale,
  renderTemplate,
} from './utils.js';

const DEFAULT_LOCALE = 'en';

function getLanguagesConfig(): LanguagesPackageConfig {
  return getPackageConfig<LanguagesPackageConfig>('languages', {
    defaultLocale: DEFAULT_LOCALE,
    overrides: {},
  });
}

interface ResolutionAttempt {
  template: string | null;
  source: ResolvedLanguageString['source'];
  resolvedFromLocale: string;
}

async function resolveBaseForLocale(
  key: string,
  locale: string,
  options: ResolveLanguageStringOptions,
  config: LanguagesPackageConfig,
): Promise<ResolutionAttempt> {
  const tenantId =
    options.tenantId !== undefined ? options.tenantId : (getTenantId() ?? null);

  let collection: LanguageOverrideCollection | null = null;
  if (options.db) {
    collection = await (LanguageOverrideCollection as any).create({
      db: options.db,
    });
  }

  const cacheDb = collection?.db ?? options.db;
  const cached = getCachedLanguage(key, locale, tenantId, cacheDb);
  if (cached) {
    return {
      template: cached.template,
      source: cached.source,
      resolvedFromLocale: cached.resolvedFromLocale,
    };
  }

  // 1. Tenant override (highest precedence among stored layers).
  if (collection && tenantId) {
    const tenantOverride = await collection.getTenantOverride(
      key,
      locale,
      tenantId,
    );
    if (tenantOverride) {
      return finalize({
        key,
        locale,
        tenantId,
        db: cacheDb,
        attempt: {
          template: tenantOverride.template,
          source: 'tenant',
          resolvedFromLocale: locale,
        },
      });
    }
  }

  // 2. App-level override (incl. AI auto-translations).
  if (collection) {
    const appOverride = await collection.getAppOverride(key, locale);
    if (appOverride) {
      return finalize({
        key,
        locale,
        tenantId,
        db: cacheDb,
        attempt: {
          template: appOverride.template,
          source: 'app',
          resolvedFromLocale: locale,
        },
      });
    }
  }

  // 3. File-config override.
  const configTemplate = config.overrides?.[key]?.[locale];
  if (typeof configTemplate === 'string') {
    return finalize({
      key,
      locale,
      tenantId,
      db: cacheDb,
      attempt: {
        template: configTemplate,
        source: 'config',
        resolvedFromLocale: locale,
      },
    });
  }

  // 4. Code default.
  const definition = LanguageRegistry.get(key, locale);
  if (definition) {
    return finalize({
      key,
      locale,
      tenantId,
      db: cacheDb,
      attempt: {
        template: definition.template,
        source: 'code',
        resolvedFromLocale: locale,
      },
    });
  }

  return {
    template: null,
    source: 'missing',
    resolvedFromLocale: locale,
  };
}

function finalize(args: {
  key: string;
  locale: string;
  tenantId: string | null;
  db: unknown;
  attempt: ResolutionAttempt;
}): ResolutionAttempt {
  if (args.attempt.template !== null) {
    const value: LanguageCacheValue = {
      key: args.key,
      locale: args.locale,
      template: args.attempt.template,
      source: args.attempt.source,
      resolvedFromLocale: args.attempt.resolvedFromLocale,
    };
    setCachedLanguage(args.key, args.locale, args.tenantId, args.db, value);
  }
  return args.attempt;
}

export async function resolveLanguageString(
  key: string,
  options: ResolveLanguageStringOptions = {},
): Promise<ResolvedLanguageString> {
  if (!key || key.trim() === '') {
    throw new Error('resolveLanguageString requires a non-empty key');
  }

  const config = getLanguagesConfig();
  const defaultLocale = normalizeLocale(config.defaultLocale ?? DEFAULT_LOCALE);
  const requested = normalizeLocale(options.locale ?? defaultLocale);

  // Runtime override always wins, regardless of locale chain.
  if (typeof options.overrides?.template === 'string') {
    return {
      key,
      locale: requested,
      template: options.overrides.template,
      text: renderTemplate(options.overrides.template, options.vars),
      resolvedFromLocale: requested,
      source: 'runtime',
    };
  }

  const chain = buildLocaleFallbackChain(requested, defaultLocale);

  let firstHit: ResolutionAttempt | null = null;
  let firstLocale = requested;
  for (const locale of chain) {
    const attempt = await resolveBaseForLocale(key, locale, options, config);
    if (attempt.template !== null) {
      firstHit = attempt;
      firstLocale = locale;
      break;
    }
  }

  if (!firstHit) {
    if (options.strict) {
      throw new Error(
        `Language string "${key}" has no resolution for locale "${requested}"`,
      );
    }
    // Soft-miss: enqueue translation if the requested locale differs from the
    // default and a default-locale source exists. Failure of the enqueue path
    // must never break resolution — we still return the key as the rendered
    // text so the UI degrades gracefully.
    await tryEnqueueTranslation({
      key,
      requestedLocale: requested,
      defaultLocale,
      options,
    });
    return {
      key,
      locale: requested,
      template: key,
      text: key,
      resolvedFromLocale: requested,
      source: 'missing',
    };
  }

  // Hit at a fallback locale that isn't the requested one — fire-and-forget a
  // translation job for the requested target.
  if (firstLocale !== requested) {
    await tryEnqueueTranslation({
      key,
      requestedLocale: requested,
      defaultLocale,
      options,
      fallbackTemplate: firstHit.template,
    });
    return {
      key,
      locale: requested,
      template: firstHit.template ?? key,
      text: renderTemplate(firstHit.template ?? key, options.vars),
      resolvedFromLocale: firstLocale,
      source: 'fallback',
    };
  }

  return {
    key,
    locale: requested,
    template: firstHit.template ?? key,
    text: renderTemplate(firstHit.template ?? key, options.vars),
    resolvedFromLocale: firstLocale,
    source: firstHit.source,
  };
}

/**
 * Best-effort enqueue of an AI translation job. Wrapped so resolution never
 * fails because of an enqueue error, missing optional dependency, etc.
 *
 * The actual job machinery lives in `./translation-job.ts` and is loaded
 * lazily so the resolver does not pull `@happyvertical/ai` into the import
 * graph for synchronous resolves that never miss.
 */
async function tryEnqueueTranslation(args: {
  key: string;
  requestedLocale: string;
  defaultLocale: string;
  options: ResolveLanguageStringOptions;
  fallbackTemplate?: string | null;
}): Promise<void> {
  if (!args.options.db) {
    // Without a DB we cannot persist a job; skip silently — resolver still
    // returns a fallback to the caller.
    return;
  }
  if (normalizeLocale(args.requestedLocale) === args.defaultLocale) {
    return;
  }

  try {
    const { enqueueTranslationJob } = await import('./translation-job.js');
    await enqueueTranslationJob({
      key: args.key,
      targetLocale: args.requestedLocale,
      sourceLocale: args.defaultLocale,
      tenantId: args.options.tenantId ?? getTenantId() ?? null,
      db: args.options.db,
    });
  } catch {
    // Enqueueing must never break resolution.
  }
}

export function invalidateResolvedLanguageCache(
  key: string,
  locale: string,
  tenantId: string | null | undefined,
  db: unknown,
): void {
  invalidateLanguageCache(key, locale, tenantId, db);
}
