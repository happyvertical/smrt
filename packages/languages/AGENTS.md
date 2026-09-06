# languages

SMRT language string registry with file/config + tenant overrides and AI-driven
auto-translation for missing locales.

## Core pieces

- `defineLanguageString({ key, locale, template })` registers a code default in
  a global process registry. Same shape as `definePrompt` but keyed by
  `(key, locale)` rather than `key` alone.
- `resolveLanguageString(key, options)` walks the 5-layer chain (code → file
  config → app override → tenant override → runtime override) and falls back
  through the locale chain (`fr-CA` → `fr` → default) before giving up.
- `LanguageOverride` stores app-level and tenant-level overrides in
  `_smrt_language_overrides`. `auto_generated`, `source_hash`, `ai_model`,
  `reviewed_at`, `reviewed_by` fields support the AI auto-translation pipeline
  and admin review queue.
- `enqueueTranslationJob({ key, targetLocale })` writes a `LanguageTranslationTask`
  job into the `languages` queue with a deterministic dedup ID so concurrent
  resolver misses collapse into one job.

## Locale-miss flow

When `resolveLanguageString` cannot find an exact `(key, locale, tenantId)`:

1. Walk the locale fallback chain (`buildLocaleFallbackChain`).
2. Return the first hit — same call returns immediately with
   `source: 'fallback'`.
3. Fire-and-forget `enqueueTranslationJob` for the missing target, scoped to
   the current tenant for glossary purposes. App-level translations are
   reusable across tenants, so the resulting `LanguageOverride` row is written
   with `tenantId: null`.
4. Subsequent requests hit the new app-level row and resolve at the requested
   locale.

The translation job:

- Honors the `smrt-languages.auto_translate` feature flag (kill switch).
- Skips locales outside `supportedLocales` when configured.
- Skips when `LanguageOverride` already exists with a matching `source_hash`
  (re-translation is hash-gated, never time-based).
- Never overwrites a row with `auto_generated: false` — human edits win
  permanently.
- Pulls the tenant's existing overrides and renders them as a glossary so
  auto-translations match tenant voice.

## Conventions

- Keys are namespaced by package: `users.role.member`, `commerce.invoice.dueText`.
- Locales follow BCP-47 (`en`, `fr-CA`, `pt-BR`) and are normalized to
  lowercase-language / uppercase-region on persistence.
- The translation prompt itself is registered with `smrt-prompts` under
  `smrt-languages.translation` so ops can tune wording without redeploying.
- `context` column on `_smrt_language_overrides` is set to `tenantId` or
  `'__app__'` so the `(key, locale, context)` upsert key remains unique even
  with nullable `tenantId`.

## Caching

`resolveLanguageString()` results are cached per `(db, key, locale, tenantId)`
with a TTL, invalidated on `LanguageOverride.save()` / `.delete()` (both
identities when one changes) and by the translation job. An app-level write
(`tenantId = null`) clears every tenant's entry for that `(key, locale)`. Use
`clearLanguageCache()` in tests.

**A monotonic per-`(db, key, locale)` invalidation generation guards the cache
write.** A resolution captures `getLanguageCacheGeneration(key, locale, db)`
before its asynchronous layer loads and hands it back to `setCachedLanguage()`;
a concurrent write bumps the generation and the in-flight resolution is then
refused the cache write instead of repopulating the entry it just invalidated
with the pre-write value. Without it, a read that raced a write served the
pre-write value for the full 30s TTL, and a raced `delete()` resurrected the
deleted override. The generation includes `locale` — unlike `smrt-playbooks`
and `smrt-prompts`, which have no locale dimension — because every layer a
cached entry is built from is read at exactly the locale it is cached under:
the fallback chain (`fr-CA` → `fr` → `en`) resolves each locale independently
and an attempt that resolves nothing caches nothing, so a fallback hit is never
stored under the requested locale. It deliberately excludes `tenantId`, because
an app-level row is inherited by every tenant. `clearLanguageCache()` raises a
single floor (`clearedThrough`) rather than resetting or per-entry bumping: a
`(key, locale)` that has never been invalidated has no map entry and reads as
generation 0, so a per-entry bump cannot reach it and a resolution that started
before the clear would write its pre-clear value back.

## Public API surface

```typescript
import {
  defineLanguageString,
  resolveLanguageString,
  LanguageOverride,
  LanguageOverrideCollection,
  clearLanguageCache,
} from '@happyvertical/smrt-languages';

defineLanguageString({
  key: 'users.role.member',
  locale: 'en',
  template: 'Member',
});

const text = await resolveLanguageString('users.role.member', {
  db,
  tenantId: 'tenant-a',
  locale: 'es',
  vars: { name: 'Will' },
});
```
