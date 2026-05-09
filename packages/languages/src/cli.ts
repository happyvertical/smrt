import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { LanguageOverrideCollection } from './collections/LanguageOverrideCollection.js';
import { LanguageRegistry } from './language-registry.js';
import { enqueueTranslationJob } from './translation-job.js';
import { normalizeLocale } from './utils.js';

/**
 * Implementation of `smrt languages translate --locales=es,fr`.
 *
 * Walks the registered code defaults and enqueues a translation job for every
 * `(key, locale)` pair that does not yet have an app-level override. The job
 * itself respects the same dedup / budget / allowlist rules as the resolver's
 * miss-path enqueue.
 */
export async function translateMissing(options: {
  locales: string[];
  sourceLocale?: string;
  db: SmrtClassOptions['db'];
  tenantId?: string | null;
}): Promise<{
  enqueued: string[];
  skipped: string[];
}> {
  const sourceLocale = normalizeLocale(options.sourceLocale ?? 'en');
  const targets = options.locales.map(normalizeLocale).filter(Boolean);
  const overrides = await (LanguageOverrideCollection as any).create({
    db: options.db,
  });

  const enqueued: string[] = [];
  const skipped: string[] = [];

  for (const definition of LanguageRegistry.getAll()) {
    if (definition.locale !== sourceLocale) continue;

    for (const target of targets) {
      if (target === sourceLocale) continue;
      const existing = await overrides.getAppOverride(definition.key, target);
      // Human edits win permanently — never enqueue an AI translation job for
      // a row that an admin has curated, even if the source has changed. The
      // CLAUDE.md spec calls this out and the job handler enforces the same
      // rule, but we prefer to skip at the enqueue layer so we don't burn
      // queue budget on work the handler is going to discard.
      if (existing && !existing.auto_generated) {
        skipped.push(`${definition.key}:${target}`);
        continue;
      }
      if (existing && existing.source_hash === definition.sourceHash) {
        skipped.push(`${definition.key}:${target}`);
        continue;
      }

      const result = await enqueueTranslationJob({
        key: definition.key,
        targetLocale: target,
        sourceLocale,
        tenantId: options.tenantId ?? null,
        db: options.db,
      });

      if (result.status === 'enqueued') {
        enqueued.push(`${definition.key}:${target}`);
      } else {
        skipped.push(`${definition.key}:${target}`);
      }
    }
  }

  return { enqueued, skipped };
}

/** `smrt languages review --locale=es` — list unreviewed auto-translations. */
export async function listUnreviewedAutoTranslations(options: {
  db: SmrtClassOptions['db'];
  locale?: string;
  limit?: number;
}) {
  const overrides = await (LanguageOverrideCollection as any).create({
    db: options.db,
  });
  return overrides.listUnreviewedAutoTranslations({
    locale: options.locale,
    limit: options.limit,
  });
}

/** `smrt languages approve <id> --reviewer=<user>` — mark reviewed. */
export async function approveAutoTranslation(options: {
  db: SmrtClassOptions['db'];
  id: string;
  reviewer: string;
}) {
  const overrides = await (LanguageOverrideCollection as any).create({
    db: options.db,
  });
  const row = await overrides.get({ id: options.id });
  if (!row) {
    throw new Error(`LanguageOverride "${options.id}" not found`);
  }
  return row.approve(options.reviewer);
}

/** `smrt languages edit <id> --template=...` — human-edit suppresses auto-overwrites. */
export async function editLanguageOverride(options: {
  db: SmrtClassOptions['db'];
  id: string;
  template: string;
  reviewer?: string;
}) {
  const overrides = await (LanguageOverrideCollection as any).create({
    db: options.db,
  });
  const row = await overrides.get({ id: options.id });
  if (!row) {
    throw new Error(`LanguageOverride "${options.id}" not found`);
  }
  row.template = options.template;
  row.auto_generated = false;
  row.ai_model = null;
  if (options.reviewer) {
    row.reviewed_at = new Date().toISOString();
    row.reviewed_by = options.reviewer;
  }
  await row.save();
  return row;
}
