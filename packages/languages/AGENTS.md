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

## Subpaths

- **root** — read path (`defineLanguageString`, `resolveLanguageString`,
  overrides, cache). Pulls smrt-core/sql/ai/jobs; server-only.
- **`/jobs`** — translation-worker stack. **`/cli`** — admin helpers.
- **`/runtime`** — browser-safe, **dependency-free** pure helpers
  (`renderTemplate`, `normalizeLocale`, `buildLocaleFallbackChain`) with no
  `node:*` imports. This is the single source of truth for the `{var}`
  interpolation + locale-matching contract, so client i18n layers (the
  smrt-svelte i18n layer, #1418) share it with the server resolver instead of
  re-implementing it. The pure helpers live in `src/runtime.ts`; `src/utils.ts`
  re-exports them and adds the crypto-dependent `computeSourceHash` /
  `buildTranslationJobId`.

## Public API surface

```typescript
import {
  defineLanguageString,
  resolveLanguageString,
  LanguageOverride,
  LanguageOverrideCollection,
  clearLanguageCache,
} from '@happyvertical/smrt-languages';
// Browser-safe interpolation/locale helpers (no server deps):
import { renderTemplate } from '@happyvertical/smrt-languages/runtime';

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
