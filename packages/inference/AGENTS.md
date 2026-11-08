# smrt-inference

Binding behavior for core's inference tiers (epic #4749). Core owns the names
and the seam ([core inference.md](../core/agents/inference.md)); this package
owns alias chains, classified fallback, ladder degradation and
`smrt doctor --ai` (#4752), and the settings panel with layered binding
storage (#4754). Fusions (#4753) build on the executor and the doctor here.

## Entries

- Root (browser-safe): importing it calls `registerInference()`, which sets
  the chain executor (`setInferenceExecutor()`) and a validating resolver
  (`setInferenceResolver()`). The resolver binds nothing: it validates chain
  config, then defers to a resolver registered earlier (#4666 per-user
  bindings) or to core's built-in config resolution. No aliases and no chain
  targets means no change in behavior. `browser-safe.test.ts` holds the graph
  free of `node:`, the AI SDK and smrt-config by walking its import graph;
  the bundle-gate browser fixture also builds it (the package has a model).
- `./node`: `checkInferenceBindings()`, `probeInferenceCandidate()`,
  `inferenceProbeUrl()`, `formatInferenceDoctorReport()`; the CLI's
  `doctor --ai` and #4754's test connection call these.
- `./models` (browser-safe, held by `browser-safe.test.ts` and the
  bundle-gate browser fixture): the `_smrt_inference_overrides` model;
  generated consumer registration imports it from here.
- `./server` (Node-only): settings service, override service, override
  resolver, key rule, preference kind (#4754). `./svelte`: the panel.

## Config

```ts
config({ inference: {
  aliases: { frontier: { candidates: [
    { provider: 'anthropic', model: 'claude-…' },               // provider key var
    { provider: 'openai', model: 'gpt-…', baseUrl, apiKeyEnv }, // own key + endpoint
    { preset: 'lemonade', model: 'qwen…' },                     // #4674 preset
    { alias: 'local' },                                         // expanded in place
  ] } },
  tiers: { great: { alias: 'frontier' }, cheap: { candidates: [ … ] } },
  degrade: true, // default
} });
```

A candidate is exactly one of provider/model, preset/model, or alias.
`apiKeyEnv` is read at call time and needs a `baseUrl` (core's pair rule: a
key only travels with its own endpoint); a named variable that is unset skips
the candidate as `credential`. `findInferenceConfigIssues()` /
`validateInferenceConfig()` name every offender by path: empty alias, unknown
alias (tier or nested), cycle, key without endpoint, unknown preset. The
executor also validates every resolved target it runs (a resolver's chains
never pass through config), and a candidate key is never dropped: without
its own `baseUrl` core's pair rule refuses it.

## Executor (`src/executor.ts`)

- Free of SDK imports: it drives the clients core builds through
  `context.clientFor(target)`; tests use fake clients.
- Failure classes (`classify.ts`): `quota | credential | missing-model |
  transient | refusal`, from error class names, `code`, `retryable` and HTTP
  status across `cause` / `error` / `context.originalError`, never message
  text. The SDK maps 5xx and other HTTP failures to `API_ERROR` /
  `UNKNOWN_ERROR` without a status or cause (happyvertical/sdk#1493); those
  count as `transient`. A definitive client error that survives in the chain
  (other 4xx, `invalid_request_error`, context length) is not a routing
  failure. Core's typed bind refusal (`INFERENCE_TARGET_UNBOUND`: pair rule,
  `HAVE_AI_*`) is `credential` and advances. Aborts and unclassified errors stop the walk and are rethrown (an
  unclassified one is still recorded).
- `transient` retries the same candidate once after 200–500 ms of jitter;
  every class then advances. A `refusal` finish reason with nothing streamed
  also advances; finish callbacks are replayed only for the kept answer.
- Streamed text is never extended: a candidate that emitted text and then
  failed ends the walk with a `partial` substitution and
  `InferenceExhaustedError` (`reason: 'partial'`, `partialText`), unless
  `allowPartial` returns the text. A `stream()` consumer that stops reading
  aborts the provider stream (internal signal merged with the caller's).
- Ladder: when a tier's chain is spent and `degrade !== false`, resolve the
  next lower tier through `context.resolveTier()`, stopping below
  `minimumTier`. Never up. Steps already tried (same identity) are skipped,
  so unbound lower tiers try the configured client once.
- Tags on the answering call: caller tags, `tierRequested`, `tierResolved`
  (the tier that answered), and `substitutions` (JSON array of
  `{ from, to, reason }`, labels `provider/model`, `preset:<id>/model`,
  `default`). A call that never answered records one zero-token row through
  `context.recordUsage()` (core's usage handlers; no second writer) with
  `outcome: failed | partial`, `reason` and the full trail ending `to: null`,
  then throws `InferenceExhaustedError` (`INFERENCE_EXHAUSTED`).
- Add a class (#4758 `missing-capability`) to `INFERENCE_FAILURE_CLASSES` and
  a kind (#4753 `fusion`) to the executor's `kinds`; consumers ignore kinds
  they do not run.

## Doctor (`src/node.ts`)

Per tier and alias: provider recognized (AI SDK provider list or preset id),
key variable present (a provider's default variable only warns: a
same-provider target inherits the configured key), model named (warns),
alias resolvable, cycle-free. `probe` GETs `/models` (OpenAI-compatible,
Anthropic, Gemini) or Ollama `/api/tags` with a 3 s timeout, sending the key
only to its own endpoint. A binding errors when its config is invalid or no
candidate can answer; one bad candidate in a working chain warns. Keys never
appear in the report.

## Settings UI and binding storage (#4754)

Consumer guide: [docs/content/inference-settings.md](../../docs/content/inference-settings.md).

- **Storage split, enforced by API shape.** Keys: the panel emits
  `onSaveKey({ provider, key, preset?, baseUrl? })` (the endpoint shown when
  the key was typed; the key input remounts on a provider or base URL
  change), the host writes through smrt-secrets'
  `SecretService` the record `bindInferenceKey()` returns, and the panel
  only ever gets `keySet` back. User choices (mode `byo | local | hosted |
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
  `listInferenceAliases()`, `listInferenceFusions()` (registry via the
  `registryFusions` option, config `inference.fusions`, editable app rows;
  soft dependency on #4753). Writes go through `InferenceOverrideService`
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
  `usage()` is `reportAiUsage()` by model (default), tier, prompt.
- **`createInferenceOverrideResolver({ db, base })`** applies stored
  bindings at call time and defers unbound tiers to `base` or config; an
  app-only alias is returned as its inline candidate chain because the
  executor reads only the process config. Rows (not layers) are cached per
  tenant for `ttlMs` (30 s) and invalidated by any write in the process; the
  allow-list and policy are re-applied on every call, and only the requested
  tier's chain is validated, so one dangling reference fails one tier. Where it sits
  relative to #4756's per-user resolver is that resolver's composition.
- **Panel** (`src/svelte`): built like `PromptSettingsPanel` (presentational,
  `svelte` optional peer, prune script, two-project Vitest, `svelte-check`,
  named `$props()` interfaces, types free of core). The default view is the
  whole screen for one provider; Advanced (tier ladder, `auto` tier,
  aliases, fusions) is not rendered until opened. The key input is its own
  form, never in state, cleared on submit. Tenant scope disables targets
  off the allow-list (display only) and makes aliases/fusions read-only.
  Rows remount on `contextKey`.

## Validation

```bash
pnpm --filter @happyvertical/smrt-inference test
pnpm --filter @happyvertical/smrt-inference typecheck
pnpm --filter @happyvertical/smrt-inference build
```
