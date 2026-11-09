# Settings UI and binding storage (#4754)

Consumer guide: [docs/content/inference-settings.md](../../../docs/content/inference-settings.md).

- **Storage split, enforced by API shape.** Keys: the panel emits
  `onSaveKey({ provider, key, preset?, baseUrl? })` (the endpoint shown when
  the key was typed; the key input remounts on a provider or base URL
  change), the host binds it with `bindInferenceKey()` and stores it once,
  as the #4756 `inference.provider-config` secret, through the user
  resolver's `write()` (`inferenceProviderConfigFromKey()` converts the
  record and re-checks the bound origin), and the panel only ever gets
  `keySet` back. User choices (mode `byo | local | hosted |
  off`, provider, base URL, model, default tier): smrt-preferences kind
  `inference` (`inferencePreferenceKind`, permissions `inference.customize`
  / `inference.personalize`; the host registers both, smrt-preferences is
  not a dependency). App/tenant bindings: `_smrt_inference_overrides`.
- **Key rule** (`src/settings/keys.ts`, ported from the planner's BYO
  screen): a key is bound when saved to the origin of its endpoint
  (explicit base URL, else preset, else `inferenceProbeUrl()`'s provider
  default, a provider id that is a preset id counting as that preset;
  https only, plain http for loopback; gateways such as
  `litellm`/`bifrost` need a base URL) and `inferenceKeyFor()` releases it
  only for a URL on that origin. `testConnection()` reads no environment key
  and never probes another origin with a stored key; details pass
  `redactInferenceSecret()`. Binding rows, preference payloads and tested
  candidates refuse credential-shaped members (`findKeyMember()`; `key` is
  allowed because #4753 fusions carry one).
- **Override table**: one row per `(binding, context)`, binding
  `tier:<tier> | default-tier | alias:<name> | fusion:<name>`, `context`
  `__app__` or the tenant id (the prompts pattern), `target` JSON,
  `tenant_allow_list` JSON on app rows. Generated surfaces are closed; ships
  through `smrt db:migrate` (`override-migration.test.ts`). A tier target is
  exactly a model `{ provider?, model }`, an alias `{ alias }` or a fusion
  `{ kind: 'fusion', fusion }`: no endpoint, key or inline chain (those go
  in an alias). Layers, low to high: code default (configured client),
  `inference` config, app row, tenant row; each target replaced whole.
- **Tenant allow-list**: a tenant writes only `tier:*` and `default-tier`,
  only to a reference (`model:<provider>/<model>`, `alias:<n>`,
  `fusion:<n>`, `tier:<t>`; trailing `*` and `*` match) on the app row's
  list (no list allows nothing), and only when the
  `tenantTargetPolicy` hook returns `true`; this hook is where #4667 caps
  the maximum hosted tier. Both are re-checked on every layered read, so a
  narrowed list or policy disables existing tenant rows (`tenantBlocked`).
  Aliases and fusions are app-scope only (a tenant definition could
  redefine an allow-listed name).
- **`InferenceSettingsService`** mirrors `PromptSettingsService`:
  `listInferenceSettings()` returns one row per tier with the effective
  target, each scope's raw value and both revert previews computed
  separately (`appRevertTarget` = config, never the app row;
  `inheritedTarget` = config + app row), plus `getDefaultTierSetting()`,
  `listInferenceAliases()`, `listInferenceFusions()` (registry: the
  `registryFusions` option, default #4753's `defineFusion()` registry;
  config `inference.fusions`; editable app rows), each entry with
  `shadows` (lower sources it replaces by name) and `issues` (what would make
  the executor refuse it, prompt keys included), the executor's precedence
  (#4800). `setFusion()` refuses credential members, then a definition that
  adds a structural issue. Writes go through `InferenceOverrideService`
  (authorizer first, fails closed; without `authorize` the service is
  read-only) and refuse a value that adds a config issue to the layer it
  lands in; removing an app alias or fusion that any row (every tenant) or
  config still names is refused (`InferenceBindingInUseError`, tenant rows
  only counted, checked after the authorizer allowed the write) unless
  config or the registry keeps defining it. Every config-backed value a row method
  returns passes `stripKeyMembers()` (config may carry literal keys);
  `getEffectiveConfig()` is server-side only. `testConnection()`, `testCandidate()` and `doctor()` reuse
  `./node`; `testCandidate()` reads a key variable only for a candidate
  already in the effective config (an unsaved one is probed keyless);
  `usage()` is `reportAiUsage()` by model (default), tier, prompt, fusion,
  template, with `transcripts: true` for per-bucket counts (#4781).
- **Transcript setting** (#4781, `src/settings/transcripts.ts`): binding
  `transcripts`, app row only (service and model refuse a tenant row),
  value `{ enabled?, sample?, maxBytes? }` checked by core's
  `assertInferenceTranscriptsConfig()`. `setTranscriptSettings()` writes it
  through the authorizer and installs it as core's
  `setAiTranscriptAppSettings()` layer (config < app row < env); the
  override resolver re-applies the app rows on every resolve (rows cached
  for `ttlMs`), `loadInferenceTranscriptSettings()` is the worker startup
  hook. `getTranscriptSettings()` adds the revert preview, the env override
  (detected by forcing both values through the layer) and the sweep's
  retention days, read-only (the sweep runs with its caller's policy).
- **`createInferenceOverrideResolver({ db, base })`** applies stored
  bindings at call time and defers unbound tiers to `base` or config; an
  app-only alias is returned as its inline candidate chain because the
  executor reads only the process config. Rows (not layers) are cached per
  tenant for `ttlMs` (30 s) and invalidated by any write in the process; the
  allow-list and policy are re-applied on every call, and only the requested
  tier's chain is validated, so one dangling reference fails one tier.
  Compose it as the per-user resolver's `fallback` (see AGENTS.md,
  "Resolver composition"). Its `lookupFusion()` (#4800) answers core's
  executor lookup from app rows only (read with no tenant, so a tenant row
  never defines a fusion), validated against config + app rows with every
  seat prompt key (`InferenceConfigError`, paths `fusion:<name>…`), app-only
  seat aliases inlined like tier aliases; an app row that exists but cannot
  be read fails `fusion-invalid` (never its value) rather than deferring (the
  list shows it as the app winner with that issue); no app row defers to
  `base`, then config. An app row shadows a config fusion of the same name.
- **Panel** (`src/svelte`): built like `PromptSettingsPanel` (presentational,
  `svelte` optional peer, prune script, two-project Vitest, `svelte-check`,
  named `$props()` interfaces, types free of core). The default view is the
  whole screen for one provider; Advanced (tier ladder, `auto` tier,
  aliases, fusions) is not rendered until opened. The key input is its own
  form, never in state, cleared on submit. Tenant scope disables targets
  off the allow-list (display only) and makes aliases/fusions read-only.
  Rows remount on `contextKey`. The transcript section is read-only unless
  `appEditable` and `onSaveTranscripts` are both passed; the Usage tab
  links counts through the host's `transcriptHref` and renders no
  transcript content (#4781).
