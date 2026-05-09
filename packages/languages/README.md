# @happyvertical/smrt-languages

Code-first language strings with config + tenant overrides and AI-driven
auto-translation for SMRT applications.

`smrt-languages` mirrors the architecture of `@happyvertical/smrt-prompts`:
packages declare their user-facing strings as code, applications and tenants
override them through file config or DB rows, and the resolver merges every
layer at runtime. v1 adds an automatic AI-translation step backed by
`@happyvertical/smrt-jobs`: the first time a string is requested in a locale
that has neither a code default nor an override, the resolver returns a
fallback locale immediately and enqueues a background translation. Subsequent
requests hit the new app-level row.

This package is a Phase 2 prerequisite of the broader package adoption epic —
issue [#1200](https://github.com/happyvertical/smrt/issues/1200).

## Why

- Today, packages hard-code labels like `'Member'`, `'Article'`, or
  `'Payment due by {dueDate}'`. There is no way for a tenant to use
  `'Subscriber'` instead of `'Member'` without forking, and no way for a
  tenant to operate in their own language.
- `smrt-prompts` already proved the layered-override pattern for AI prompts.
  `smrt-languages` applies the same pattern to display strings, plus an
  AI-driven gap-filler that closes the loop on missing locales without
  blocking on the first request.

## Quick start

```typescript
import {
  defineLanguageString,
  resolveLanguageString,
} from '@happyvertical/smrt-languages';

// Define defaults at startup, typically in your package's
// __smrt-register__.ts so the registry is populated before resolves run.
defineLanguageString({
  key: 'users.role.member',
  locale: 'en',
  template: 'Member',
});

defineLanguageString({
  key: 'commerce.invoice.dueText',
  locale: 'en',
  template: 'Payment due by {dueDate}',
});

// Resolve at runtime. Tenant context is read from AsyncLocalStorage by default.
const text = await resolveLanguageString('users.role.member', {
  db,
  locale: 'es',
  vars: { dueDate: '2026-06-01' },
  // strict: false → return the English fallback and enqueue an AI translation.
  // strict: true  → throw when no resolution exists.
});
```

## Resolution layers

In ascending priority:

1. **Code default** — `defineLanguageString({ key, locale, template })`
2. **File/config override** — `getPackageConfig('languages').overrides[key][locale]`
3. **App-level stored override** — `LanguageOverride` row with `tenantId = null`
4. **Tenant-level stored override** — `LanguageOverride` row with `tenantId = <current>`
5. **Runtime override** — `resolveLanguageString(key, { overrides: { template: '...' } })`

When the requested `(key, locale)` doesn't exist anywhere, the resolver walks
a fallback chain — `fr-CA` → `fr` → registered default-locale (`en`) — and
returns the first hit. Whenever the hit is at a different locale than what
was requested, an AI translation job is enqueued for the original target.

## Storage

Overrides live in `_smrt_language_overrides`:

| Column | Notes |
|--------|-------|
| `key` | Namespaced string key (`users.role.member`) |
| `locale` | BCP-47 tag (`en`, `fr-CA`) |
| `tenantId` | `null` for app-level, tenantId for tenant-level |
| `template` | The override string with `{var}` placeholders |
| `auto_generated` | `true` when produced by the AI translation job |
| `source_hash` | sha256 of the source template at translation time |
| `ai_model` | Model identifier; `null` for human-edited rows |
| `reviewed_at` / `reviewed_by` | Set when an admin approves an auto row |

Source-hash gating means re-translation only happens when the source actually
changes — auto-generated rows whose `source_hash` matches are left alone.
Human-edited rows (`auto_generated: false`) are **never** overwritten.

## AI auto-translation

When a `(key, targetLocale)` is missed, the resolver enqueues a
`LanguageTranslationTask` job into the `languages` queue with a deterministic
dedup ID — `smrt-languages.translate:<key>:<targetLocale>` — so concurrent
misses collapse into a single job. The job:

1. Reads the tenant's existing language overrides as a glossary (no-op when
   no tenant context).
2. Calls `@happyvertical/ai` with a low-temperature translation prompt that
   itself is registered via `smrt-prompts` under
   `smrt-languages.translation` — operators can tune the wording without
   redeploying.
3. Validates the response (non-empty, no obvious markup leaks).
4. Upserts an app-level `LanguageOverride` row with `auto_generated: true`,
   `source_hash`, and `ai_model`.
5. Invalidates the resolver cache for `(key, targetLocale, *)`.

### Cost & abuse controls

- `smrt-features` flag `smrt-languages.auto_translate` — global / per-tenant
  kill switch.
- `translationBudgetPerTenantPerDay` — daily cap per tenant.
- `supportedLocales` — optional allowlist; jobs for other locales are dropped
  before any AI call.
- Source-hash gating prevents re-translation when nothing changed.

### Admin review

```bash
smrt languages translate --locales=es,fr,de   # batch eager pre-population
smrt languages review --locale=es              # list unreviewed auto rows
smrt languages approve <id>                    # mark reviewed
smrt languages edit <id> --template "..."      # edit + flip auto_generated to false
```

CLI surfaces are auto-generated by SMRT from the `LanguageOverride` model and
helpers in `src/cli.ts`.

## Configuration

`smrt.config.{js,ts,json}`:

```js
export default {
  packages: {
    languages: {
      defaultLocale: 'en',
      supportedLocales: ['en', 'es', 'fr', 'de', 'ja'],
      translationBudgetPerTenantPerDay: 200,
      overrides: {
        'users.role.member': {
          es: 'Miembro',
        },
      },
    },
  },
};
```

## Out of scope (v1)

Pluralization, ICU MessageFormat, Svelte component i18n, RTL layout, locale
negotiation HTTP middleware, XLIFF/PO TM-tool integration, and richer quality
scoring of AI translations are all v1.1+ concerns. v1 sticks to plain
`{var}` substitution and the resolution chain above so adoption stays a
mechanical refactor across consumer packages.
