# smrt-prompts

SMRT prompt registry and tenant-aware prompt override package. Code defines defaults; config layers and DB-stored overrides personalize at app and tenant levels.

## Core pieces

- `definePrompt()` registers code defaults in a global process registry (`globalThis.__smrtPromptRegistry`)
- `resolvePrompt()` merges code defaults, file/config overrides (via `@happyvertical/smrt-config`), stored app-level overrides, stored tenant-level overrides, and a runtime override
- `PromptOverride` (`_smrt_prompt_overrides` table) stores partial app-level and tenant-level overrides with write-time validation
- `PromptOverrideCollection` — collection API, plus `setTemplateOverride()` / `removeOverride()` / `findByScope()` / `getOverrideMapForKeys()` for the write and enumeration paths below
- `PromptOverrideService` — the only write path a host should use directly; asks a host-supplied authorizer before every write and fails closed (mirrors `FeatureOverrideService`, #3013); before authorizing it rejects any scope the resolver never reads (`InvalidPromptScopeError`: unknown type, app id other than `__app__`, blank/untrimmed/`__app__` tenant id), so a malformed tenant write cannot reach the app-wide row
- `PromptSettingsService` — read/write helper for a management screen: `listPromptSettings()` returns one `PromptSettingsRow` per registered key (the effective template, `appTemplate`/`tenantTemplate` for the raw override at each scope, `appDefaultTemplate`/`inheritedTemplate` for what reverting each scope produces, and `supplyingLevel`); `setPromptOverride()` refuses unknown keys and fields the definition marks not editable, then delegates to `PromptOverrideService` (#3053)
- `./svelte` subpath — `PromptSettingsPanel`, the presentational management panel (#3053)

## Resolution layers (priority low → high)

1. Code default — registered via `definePrompt({ key, template, ai })`
2. File/config override — `getPackageConfig<PromptPackageConfig>('prompts', defaults)`
3. App-level stored override — `PromptOverride` row with `tenantId = null`
4. Tenant-level stored override — `PromptOverride` row with current tenant
5. Runtime override — passed to `resolvePrompt({ overrides })`

Each layer can override any subset of fields (template, profile, model, params). Inheritance is field-by-field.

## Conventions

- **Namespace prompt keys** by package or domain: `projects.issue.incorporateFeedback`, `content.summarize.headline`
- **Stored overrides use nullable fields** so inheritance stays field-by-field — null means "use the lower layer"
- **Provider selection is indirect** in v1: prompts select named profiles, and profiles resolve to provider/model in `smrt-config`
- **`editable` flags are enforced on `PromptOverride.save()`** — definitions can lock specific fields against tenant override
- **Tier names are reserved profile names** (#4750): `cheap`, `good`, `great`, `best` and `auto` need no `profiles` entry. `resolvePrompt()` only marks them (`ai.tier`, `ai.promptKey`, and the code default's `ai.latency`) and never copies a binding into `provider`/`model`/`params`: the tier binds once, at call time, through core's seam (`prepareAiOperation()` / `getAiClient(tier)`) with the prompt key, so prompt and call cannot disagree. `allowedProfileNames` applies to tier names chosen by config or an override, but not to the tier the code default itself declares when no config, stored or runtime layer sets a profile (#4755), so an allow-list never breaks framework prompts. An explicit prompt `model` stays validated by `allowedModels` and is sent per call on the tier client. **Footgun:** a same-named `profiles` entry wins and silently opts that name out of tiers. `definePrompt({ ai: { minimumTier } })` sets the ladder floor for a tier prompt (#4752); it is read from the code default only (stripped from params at every layer), so config and tenant overrides cannot lower it, and `promptMessageOptions()` forwards it with `tier`. `tier`, `latency` and `promptKey` never come from params. The canonical `promptMessageOptions()` forwards them; callers send the result through `prepareAiOperation()` (`SmrtClass`, so collections too), which strips them before the provider call. Sites holding their own client (content chat and thumbnails, facts' injected message-only client, the translation job, `Issue`'s explicit-provider path) pass `{ routeTier: false }` or drop the keys, so the prompt's tier does not route there and records no tier tags; the translation job and `Issue`'s path still apply a stored tenant or user binding through core's `resolveInferenceTarget({ appBindings: false })` (#4756), which adds tier and `source` tags only when a binding applied.

## Generated surfaces

`PromptOverride` ships with generated REST routes, MCP tools, and CLI commands
closed (`api: false`, `cli: false`, `mcp: false`, mirrors `FeatureOverride`,
#3013). Override rows are authorization state for every scope and `tenantId` is
an ordinary settable field, not request-derived tenant scoping — a generated
authentication-only surface would let any signed-in principal set another
tenant's prompt text. Hosts write overrides server-side with
`PromptOverrideService` (which requires an explicit authorizer for every
write) or `PromptOverrideCollection.setTemplateOverride()` /
`removeOverride()` only after their own authorization decision.

## Management UI (`./svelte`)

- Built like every other Svelte-shipping package here (`smrt-features`/`smrt-tenancy` are the closest models): `vite build --mode library && svelte-package -i src/svelte -o dist/svelte`, an `./svelte` export with a `svelte` condition, `svelte` as an **optional** peer dependency, plus `scripts/prune-svelte-package-artifacts.js` so `svelte-package` does not copy `__tests__/` into the published `dist/svelte`. The root export stays Svelte-free so server-only consumers are unaffected.
- `PromptSettingsPanel` is presentational: rows and callbacks in, no fetching, no authorization. `src/svelte/types.ts` deliberately imports nothing from `smrt-core` or the `@smrt()` models, so the browser bundle stays thin; `PromptSettingsRow` is structurally assignable to `PromptSettingsView`.
- Each row is its own `<form>` with a checkbox + `<textarea>` pair per scope (`tenantOverride`/`tenantTemplate`, and `appOverride`/`appTemplate` when `showApp` is set). The checkbox's presence in the submitted `FormData` — not whether the textarea is disabled — decides override vs. revert, because a plain HTML submit cannot un-disable a field the browser already marked disabled. `onSave` reads the same `FormData` when driving the panel from a client handler instead of `formAction`.
- Two invariants, both regression-tested. (1) The "revert" preview never claims the bare registry default: `tenantRevertPreview()` shows `inheritedTemplate` (registry + config + app override), falling back to `appDefaultTemplate` only when the row does not carry it, and `appRevertPreview()` shows `appDefaultTemplate` (registry + config, never the app override itself). `PromptSettingsService` computes both explicitly rather than deriving one from the other — an earlier draft reused the app-only merge as the "no tenant requested" effective value and broke both. (2) The rows remount on `contextKey ?? prompts`, so an unsaved edit cannot survive a reload or a tenant switch and be submitted against the new rows.
- **Authorization stays with the consumer.** `PromptSettingsService` reads are unfiltered and every write goes through `PromptOverrideService`; constructing the settings service without an `authorize` option makes it read-only (writes fail closed). Never add an authorization decision to this package.
- `vitest.config.ts` runs two projects (`server` node + `smrtVitestPlugin`, `svelte` jsdom + `@sveltejs/vite-plugin-svelte` with `conditions: ['browser']`) because the browser condition would send `smrt-core` to its browser build if applied globally.
- `PromptSettingsService.create()` builds its `PromptOverrideCollection` with the caller's `defaultListLimit`/`maxListLimit` stripped before the bulk `getOverrideMapForKeys()` enumeration read that backs `listPromptSettings()` — the #3056 hazard class in `smrt-features`'s `FeatureOverrideCollection.getOverrideMap()`, applied here proactively rather than left for a follow-up issue. A host-configured list bound must never silently drop a key's override from a management screen.

## Usage tags (#4751)

`resolvePrompt()` returns `ai.usageTags = { promptKey, promptLayer,
templateHash }`: `promptLayer` is the highest layer that supplied the template
(`default | config | app | tenant | runtime`; a params-only layer does not
count), `templateHash` the first 12 hex chars of the SHA-256 of the unrendered
effective template (Web Crypto, so the root stays free of `node:crypto`).
`promptMessageOptions(ai, { usageTags? })` is the one helper that turns a
resolution into `ai.message()` options; package copies re-export it. Tag
precedence, low to high: a `usageTags` object in params (tenant-editable, so
reserved tags — identity, `runId`, tier, `substitutions`, `fusionKey` — are
dropped from it), the resolution's tags, the caller's. Params never carry
`tier`, `latency` or `promptKey` either: tier routing comes only from the
validated profile. Every consumer
call site must forward them (`promptMessageOptions()` or a spread of
`resolved.ai`); core lifts `promptKey` into `_smrt_ai_usage.prompt_key`
(`../core/agents/ai-usage.md`).

## Framework prompt tiers (#4755)

Every framework `definePrompt()` declares `ai.profile` as a tier: closed-
vocabulary classification and yes/no predicates → `cheap`; summaries,
descriptions, translations, headlines → `good`; synthesis over user content
that is persisted or applied (feedback incorporation, reviews, corrections,
fact extraction and reconciliation) → `great`; nothing defaults to `best`.
`ai.latency` is `interactive` on request paths (chat, editor) and `background`
for jobs, else unset; only the code default declares it. Prompts that make no model call (persona instructions,
chat system prompts) or call a non-text model (image generation) declare no
tier. An explicit model on the call path wins over the tier. Each package's
`AGENTS.md` records its choices; one test per package pins the tag set.

## Prompt keys are persisted identifiers

Overrides are stored keyed by the exact `key` string and resolved by that
string at runtime. **Renaming a key orphans every existing override and
silently reverts every tenant to the registry default**, and it also orphans
the key's `_smrt_ai_usage` series: history stays under the old `prompt_key`
and outcome labels never join the new one. Treat a shipped key as immutable;
a rename needs a data migration over `_smrt_prompt_overrides.key`, not an edit.

## Caching

`resolvePrompt()` results are cached per `(key, tenantId)` with a TTL. The cache is invalidated on `PromptOverride.save()` and `.delete()`. Use `clearPromptCache()` for manual invalidation in tests.

**A monotonic per-`(db, key)` invalidation generation guards the cache write.**
A resolution captures `getPromptCacheGeneration(key, db)` before its
asynchronous layer loads and hands it back to `setCachedPromptBase()`; a
concurrent `save()` / `delete()` bumps the generation and the in-flight
resolution is then refused the cache write instead of repopulating the key it
just invalidated with the pre-write value. Without it, "a stale entry is never
served after a write" held only until a read raced a write, and then failed for
the full 30s TTL (a raced `delete()` resurrected the deleted override).
Generations are tracked per `(db, key)`, not per tenant, because an app-level
row is inherited by every tenant. `clearPromptCache()` raises a single floor
(`clearedThrough`) rather than resetting or per-key bumping: a key that has
never been invalidated has no map entry and reads as generation 0, so a per-key
bump cannot reach it and a resolution that started before the clear would write
its pre-clear value back. `smrt-languages` carries the same mechanism, keyed
additionally by locale. `smrt-playbooks` has the generation but not the floor
(#2716).

## Related

- `@happyvertical/smrt-languages` — parallel package for language strings (uses the same architecture pattern)
- `@happyvertical/smrt-features` — parallel package for feature flags
