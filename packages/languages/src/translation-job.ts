import { getAI } from '@happyvertical/ai';
import { getPackageConfig } from '@happyvertical/smrt-config';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { FeatureResolver } from '@happyvertical/smrt-features';
import { SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { definePrompt, resolvePrompt } from '@happyvertical/smrt-prompts';
import { invalidateLanguageCache } from './cache.js';
import { LanguageOverrideCollection } from './collections/LanguageOverrideCollection.js';
import { buildTenantGlossary } from './glossary.js';
import { LanguageRegistry } from './language-registry.js';
import type { LanguagesPackageConfig, TranslationJobPayload } from './types.js';
import {
  buildTranslationJobId,
  computeSourceHash,
  normalizeLocale,
} from './utils.js';

/** Feature flag key honored as the kill-switch for AI auto-translation. */
export const AUTO_TRANSLATE_FEATURE_KEY = 'smrt-languages.auto_translate';

/**
 * Prompt key registered with `smrt-prompts` so ops can tune the AI translation
 * style without redeploying. The prompt itself is referenced by the job
 * handler when calling `@happyvertical/ai`.
 */
export const TRANSLATION_PROMPT_KEY = 'smrt-languages.translation';

definePrompt({
  key: TRANSLATION_PROMPT_KEY,
  template:
    'You translate user-facing application strings from {sourceLocale} to {targetLocale}.\n' +
    'Preserve any "{var}" placeholders exactly. Do not add markup or commentary.\n' +
    'Match the organization glossary where applicable:\n{glossary}\n' +
    'String to translate: "{template}"\n' +
    'Reply with a JSON object: {"translation": string}.',
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

/**
 * SmrtObject that owns the translation job's `execute` method. The TaskRunner
 * resolves jobs by `objectType` so the registered class name needs to match
 * what `enqueueTranslationJob` writes.
 */
@smrt({
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class LanguageTranslationTask extends SmrtObject {
  /**
   * Job-runner entrypoint. Reads the translation payload, calls
   * `@happyvertical/ai`, and upserts a `LanguageOverride` row.
   */
  async execute(args: TranslationJobPayload): Promise<{
    skipped?: 'feature_disabled' | 'not_supported' | 'budget' | 'stale';
    template?: string;
  }> {
    if (!args || !args.key || !args.targetLocale || !args.sourceTemplate) {
      throw new Error(
        'LanguageTranslationTask.execute requires a translation payload',
      );
    }

    const config = getLanguagesConfig();
    const targetLocale = normalizeLocale(args.targetLocale);
    const sourceLocale = normalizeLocale(args.sourceLocale);

    // Locale allowlist (cheap pre-check before any AI / DB work).
    if (
      Array.isArray(config.supportedLocales) &&
      config.supportedLocales.length > 0 &&
      !config.supportedLocales.map(normalizeLocale).includes(targetLocale)
    ) {
      return { skipped: 'not_supported' };
    }

    // Feature flag kill switch (best-effort — never blocks if unavailable).
    if (await isAutoTranslateDisabled(args.tenantId ?? null, this.options)) {
      return { skipped: 'feature_disabled' };
    }

    const overrides = await (LanguageOverrideCollection as any).create(
      this.options,
    );

    // Source-hash gate: if a translation already exists with the same source,
    // do nothing. Only re-translate when the source changed.
    const existing = await overrides.getAppOverride(args.key, targetLocale);
    if (existing?.auto_generated && existing.source_hash === args.sourceHash) {
      return { skipped: 'stale', template: existing.template };
    }
    if (existing && !existing.auto_generated) {
      // Human-edited rows are never overwritten.
      return { skipped: 'stale', template: existing.template };
    }

    // Per-tenant daily budget.
    if (
      args.tenantId &&
      typeof config.translationBudgetPerTenantPerDay === 'number'
    ) {
      const used = await countTodayTenantTranslations(
        this.options,
        args.tenantId,
      );
      if (used >= config.translationBudgetPerTenantPerDay) {
        return { skipped: 'budget' };
      }
    }

    // Build glossary from tenant overrides (no-op when no tenant context).
    let glossary = '';
    if (args.tenantId) {
      const tenantOverrides = await overrides.listTenantOverrides(
        args.tenantId,
      );
      glossary = buildTenantGlossary(tenantOverrides, {
        sourceLocale,
        targetLocale,
        max: 25,
      });
    }
    if (!glossary) {
      glossary = '(no organization glossary)';
    }

    const prompt = await resolvePrompt(TRANSLATION_PROMPT_KEY, {
      tenantId: args.tenantId ?? null,
      variables: {
        sourceLocale,
        targetLocale,
        template: args.sourceTemplate,
        glossary,
      },
    });

    const aiConfig: Record<string, unknown> = { ...(prompt.ai ?? {}) };
    if (args.model) aiConfig.model = args.model;
    const ai = await getAI(aiConfig as any);

    const message = await ai.message(prompt.text, {
      ...(prompt.ai as Record<string, unknown>),
      responseFormat: { type: 'json_object' },
    });

    const translated = parseTranslationResponse(message);
    if (!translated) {
      throw new Error(
        `LanguageTranslationTask: AI returned no usable translation for "${args.key}" → ${targetLocale}`,
      );
    }

    if (containsObviousMarkupLeak(translated)) {
      throw new Error(
        `LanguageTranslationTask: refusing to persist suspicious translation for "${args.key}"`,
      );
    }

    const aiModel = (prompt.ai?.model as string | undefined) ?? null;
    const sourceHash =
      args.sourceHash || computeSourceHash(args.sourceTemplate);

    if (existing) {
      existing.template = translated;
      existing.auto_generated = true;
      existing.source_hash = sourceHash;
      existing.ai_model = aiModel;
      existing.reviewed_at = null;
      existing.reviewed_by = null;
      await existing.save();
    } else {
      // Use the collection's create() so the new row is initialized against
      // the same DB the task is running on. Constructing `new LanguageOverride`
      // directly leaves it un-initialized and `.save()` then trips on the
      // "Database accessed before initialization" guard.
      await overrides.create({
        key: args.key,
        locale: targetLocale,
        tenantId: null,
        template: translated,
        auto_generated: true,
        source_hash: sourceHash,
        ai_model: aiModel,
        reviewed_at: null,
        reviewed_by: null,
      });
    }

    invalidateLanguageCache(args.key, targetLocale, null, this.db);
    return { template: translated };
  }
}

interface EnqueueTranslationOptions {
  key: string;
  targetLocale: string;
  sourceLocale?: string;
  tenantId?: string | null;
  db: unknown;
  /** When true, skip the dedup check and force a fresh job. */
  force?: boolean;
}

/**
 * Enqueue a translation job for `(key, targetLocale)`, deduplicated against
 * any already-pending job for the same target. Returns the (possibly existing)
 * job's deterministic ID.
 */
export async function enqueueTranslationJob(
  options: EnqueueTranslationOptions,
): Promise<{ id: string; status: 'enqueued' | 'duplicate' | 'skipped' }> {
  const targetLocale = normalizeLocale(options.targetLocale);
  const sourceLocale = normalizeLocale(options.sourceLocale ?? 'en');
  const dedupId = buildTranslationJobId(options.key, targetLocale);

  const definition = LanguageRegistry.get(options.key, sourceLocale);
  if (!definition) {
    return { id: dedupId, status: 'skipped' };
  }

  const config = getLanguagesConfig();
  if (
    Array.isArray(config.supportedLocales) &&
    config.supportedLocales.length > 0 &&
    !config.supportedLocales.map(normalizeLocale).includes(targetLocale)
  ) {
    return { id: dedupId, status: 'skipped' };
  }

  const jobs = await (SmrtJobCollection as any).create({ db: options.db });

  if (!options.force) {
    const existing = await findPendingTranslationJob(
      jobs,
      options.key,
      targetLocale,
    );
    if (existing) {
      return { id: dedupId, status: 'duplicate' };
    }
  }

  const payload: TranslationJobPayload = {
    key: options.key,
    sourceLocale,
    sourceTemplate: definition.template,
    sourceHash: definition.sourceHash,
    targetLocale,
    tenantId: options.tenantId ?? null,
  };

  const job = await jobs.create({
    queue: 'languages',
    objectType: 'LanguageTranslationTask',
    objectId: null,
    method: 'execute',
    args: { ...payload, _dedupId: dedupId },
    runAt: new Date(),
    priority: 25,
  });
  await job.save();

  return { id: dedupId, status: 'enqueued' };
}

/**
 * In-memory match cap for the dedup scan. We pull the most recently-queued
 * language jobs and check them in JS because querying inside a JSON column
 * portably across SQLite/Postgres is fiddly. If the working queue is deeper
 * than this, the scan truncates — when that happens we log a warning instead
 * of silently letting duplicate jobs slip through, and the handler's
 * source-hash gate (`execute()`) still prevents redundant AI calls. Tune via
 * `packages.languages.dedupScanLimit` if your steady-state pending queue
 * regularly exceeds the default.
 */
const DEFAULT_DEDUP_SCAN_LIMIT = 500;

async function findPendingTranslationJob(
  jobs: SmrtJobCollection,
  key: string,
  targetLocale: string,
): Promise<unknown | null> {
  const dedupId = buildTranslationJobId(key, targetLocale);
  const config = getLanguagesConfig();
  const scanLimit =
    typeof (config as { dedupScanLimit?: number }).dedupScanLimit === 'number'
      ? (config as { dedupScanLimit: number }).dedupScanLimit
      : DEFAULT_DEDUP_SCAN_LIMIT;

  const rows = await jobs.list({
    where: {
      objectType: 'LanguageTranslationTask',
      method: 'execute',
      status: ['pending', 'running'],
      queue: 'languages',
    },
    orderBy: 'createdAt DESC',
    limit: scanLimit,
  });

  for (const row of rows) {
    const args = (row as { args?: Record<string, unknown> }).args ?? {};
    if (args._dedupId === dedupId) return row;
    if (
      args.key === key &&
      typeof args.targetLocale === 'string' &&
      normalizeLocale(args.targetLocale as string) === targetLocale
    ) {
      return row;
    }
  }

  if (rows.length === scanLimit) {
    // Don't crash; the handler's source-hash gate is the durable safeguard.
    // But surface a warning so operators notice when the queue depth has
    // outgrown the in-memory match window.
    console.warn(
      `[smrt-languages] translation-job dedup scan hit its limit (${scanLimit}); raise packages.languages.dedupScanLimit if duplicate jobs appear`,
    );
  }
  return null;
}

async function countTodayTenantTranslations(
  options: { db?: unknown },
  tenantId: string,
): Promise<number> {
  try {
    const jobs = await (SmrtJobCollection as any).create({ db: options.db });
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const rows = await jobs.list({
      where: {
        objectType: 'LanguageTranslationTask',
        method: 'execute',
        tenantId,
        createdAt: { op: '>=', value: since.toISOString() },
      },
    });
    return rows.length;
  } catch {
    return 0;
  }
}

function getLanguagesConfig(): LanguagesPackageConfig {
  return getPackageConfig<LanguagesPackageConfig>('languages', {
    defaultLocale: 'en',
    overrides: {},
  });
}

async function isAutoTranslateDisabled(
  tenantId: string | null,
  options: { db?: unknown },
): Promise<boolean> {
  try {
    const resolver = new FeatureResolver(options as any);
    const enabled = await resolver.isEnabled(AUTO_TRANSLATE_FEATURE_KEY, {
      tenantId: tenantId ?? undefined,
    });
    return enabled === false;
  } catch {
    // If features package can't resolve (no definition synced, etc.), default
    // to enabled — operators opt out by registering the flag.
    return false;
  }
}

function parseTranslationResponse(
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  try {
    const parsed = JSON.parse(message);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.translation === 'string'
    ) {
      const cleaned = parsed.translation.trim();
      return cleaned.length > 0 ? cleaned : null;
    }
  } catch {
    // Fall through — the model may have returned a bare string.
  }

  const trimmed = String(message).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function containsObviousMarkupLeak(value: string): boolean {
  // Cheap defense: refuse responses that look like raw HTML/system tags. We
  // can tighten this in v1.1 once we have telemetry on real failure modes.
  return /<\/?(script|html|body|iframe|system)/i.test(value);
}
