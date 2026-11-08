# smrt-inference

Binding behavior for core's inference tiers (epic #4749). Core owns the names
and the seam ([core inference.md](../core/agents/inference.md)); this package
owns alias chains, classified fallback, ladder degradation and
`smrt doctor --ai` (#4752), the fusion interpreter (#4753), and the settings
panel with layered binding storage (#4754).

## Entries

- Root (browser-safe): importing it calls `registerInference()`, which sets
  the executor (`alias`, `candidates`, `fusion`) and a validating resolver
  (`setInferenceResolver()`). The resolver binds nothing: it validates chain
  config, then defers to a resolver registered earlier (#4666 per-user
  bindings, `./resolver`) or to core's built-in config resolution. No aliases and no chain
  targets means no change in behavior. `browser-safe.test.ts` holds the graph
  free of `node:`, the AI SDK and smrt-config by walking its import graph;
  the bundle-gate browser fixture also builds it (the package has a model).
- `./node`: `checkInferenceBindings()`, `probeInferenceCandidate()`,
  `inferenceProbeUrl()`, `formatInferenceDoctorReport()`; the CLI's
  `doctor --ai` and #4754's test connection call these. Also hosted
  provisioning (`src/hosted.ts`, #4759).
- `./resolver` (Node-only, #4756): `createUserInferenceResolver()` and
  `registerUserInferenceResolver()` over smrt-secrets / tenancy / users. The
  root re-exports only the browser-safe stored-config shape
  (`src/provider-config.ts`): parse, redact, tier → target map.
- `./models` (browser-safe, held by `browser-safe.test.ts` and the
  bundle-gate browser fixture): the `_smrt_inference_overrides` model;
  generated consumer registration imports it from here.
- `./server` (Node-only): settings service, override service, override
  resolver, key rule, preference kind (#4754). `./svelte`: the panel.

## Per-user and per-tenant bindings (`src/resolver.ts`, #4756)

`createUserInferenceResolver({ db | secrets, fallback?, ttlMs?, principal? })`
is core's `InferenceResolver`. Per tier, highest first: the user's stored
config (its `tiers[tier]`, then its default binding), the tenant's (same
order), `fallback`, the app `inference` block, then the configured client
(`SMRT_AI_*` / process `ai`). Every resolution carries `target.source`
(`byo | local | hosted | app`); core records it as the `source` usage tag.

- **Registration order.** `registerUserInferenceResolver(r)` installs
  `createInferenceResolver(r)`: the #4752 validating resolver stays outermost
  (chain config is validated first), then the user resolver, then its
  `fallback`, then core's config resolution. A later `registerInference()`
  keeps it (the wrapper is marked as this package's own); a bare
  `setInferenceResolver(r)` would drop the validation.
- **Storage.** One smrt-secrets type, `inference.provider-config`
  (`category`), via `SecretService.store()` / `retrieve()` only, with
  `context = tenantId`. Names: `inference.provider-config:user:<userId>` and
  `inference.provider-config:tenant`. The value is
  `{ provider, baseUrl, model, apiKey, preset, params, source?, mode?,
  gatewayKeyAlias?, tiers? }`; hosted (#4759) writes the same type with
  `source: 'hosted'` and `gatewayKeyAlias` (refused on any other source;
  every target of the config carries it as `usageTags`).
  `parseInferenceProviderConfig()` requires every binding to be
  self-contained (`baseUrl` and `apiKey`, `'smrt-local'` for keyless local
  servers, or a preset that supplies the endpoint), so a stored binding never
  borrows the server's environment credentials; it also refuses a `baseUrl`
  with userinfo, query or fragment, `params` beyond the scalar generation
  options in `INFERENCE_PROVIDER_PARAM_KEYS`, a preset without a model,
  unknown fields, and `source: 'app'`. Redaction copies known non-secret
  fields only. A corrupt stored value fails the call with
  `InferenceProviderConfigError` (paths only, never values); a missing,
  disabled or expired secret is simply no layer.
- **Identity.** The ambient principal (tenancy context, then the users
  session context: smrt-preferences' order). With a principal: its tenant
  and user. A request for another tenant (an object of tenant B used by a
  principal of A) reads nothing stored and falls through to app config,
  unless `allowCrossTenant` (then B's tenant layer, no user). No principal
  (jobs): the request's tenant, no user layer, never a guess.
  `request.userId === null` (core `resolveInferenceTarget({ userId: null })`)
  skips the user layer for clients shared beyond one user (agents); a string
  `userId` is ignored.
- **Cache.** Decrypted layers per `(tenantId, userId)` for `ttlMs` (30 s);
  failed loads are evicted. `write(level, config)` / `remove(level)` store
  for the current principal and invalidate; `invalidate()` takes all, one
  tenant (every user), or one user. Who may write the tenant config is the
  host server action's decision (#4754).
- **Mode (#4757).** A stored config may carry `mode` (`byo | local | hosted
  | off`) and may hold only a mode (no binding, no key). The user's mode,
  else the tenant's, applies: `off` answers every tier `{ unavailable:
  'off' }` and `mode()` (untiered calls) `{ mode: 'off', unavailable: 'off' }`;
  `byo` / `local` / `hosted` bind only a stored binding of that `source`
  (user, then tenant), else `unavailable: 'unconfigured'`, never app config.
  No mode: the order above, reporting the binding's source as `mode`.
  `mode()` returns an explicit mode, which core uses to route untiered calls
  through `auto` (so they bind the same way).
  `setMode(level, mode | null)` keeps the binding (deletes a config left
  empty) and invalidates; `write()` replaces the whole config, mode
  included. `resolveBindings()` adds `mode: { mode, layer }`. The #4752
  wrapper forwards `mode()` only when the base has one.
- **Keys.** Never logged or tagged. `resolveBindings()` returns the tier map
  and both stored configs redacted by default (`hasApiKey`, no `apiKey`), the
  shape the settings panel reads; `redact: false` is server-only.
- Raw `getAI()` sites take the binding through core's
  `resolveInferenceTarget()` (see [core inference.md](../core/agents/inference.md)).

## Hosted provisioning (`src/hosted.ts`, #4759)

`provisionHostedInference({ db, tenantId, userId, budget })`,
`revokeHostedInference({ db, tenantId, userId })`, or one
`createHostedInferenceProvisioner({ db, secrets?, gateway?, admin?, actor? })`
(`provision`, `revoke`, `syncBudget`, `status`, `listActive`, `revokeTenant`,
`syncTenantBudget`).

- **Gateway.** Admin calls go through `ai.admin` (`AIAdminInterface`) of the
  `bifrost` / `litellm` provider of `@happyvertical/ai`; never reimplement
  gateway administration here. The SDK has `createProject` and
  `createVirtualKey` only: `updateVirtualKey` / `deleteVirtualKey` are
  feature-detected on `HostedGatewayAdmin` (happyvertical/sdk#1494). Without
  them budget sync returns `unsupported` (state keeps the old budget so a
  later sync retries) and revoke returns `gateway: 'unsupported'`, still
  removing the key locally and auditing `manualGatewayRevocation` with the
  key's id and alias. A failing delete call changes nothing (retry).
- **Config, read once from the environment** (`getHostedGatewayConfig()`;
  unset provider = hosted off): `SMRT_INFERENCE_HOSTED_PROVIDER`
  (`bifrost|litellm`), `_BASE_URL` (the OpenAI-compatible endpoint keys are
  used against), `_ADMIN_URL`, `_ADMIN_KEY` (LiteLLM master key, required for
  litellm; or a Bifrost admin key), `_ADMIN_USER` / `_ADMIN_PASSWORD`
  (Bifrost Basic auth), `_MODEL`, `_<TIER>_MODEL`, `_MODELS` (comma list the
  key may use; default the binding's models), `_KEY_DURATION`. Errors name
  missing fields, never values.
- **Storage** (smrt-secrets, `context = tenantId`): the key lives only in
  the user's `inference.provider-config:user:<id>` (`source: 'hosted'`,
  `mode: 'hosted'`, `gatewayKeyAlias`, a binding per configured tier);
  `inference.hosted:user:<id>` (category `inference.hosted`) holds status,
  generation, key id and alias, budget and the user's prior config;
  `inference.hosted:project` the tenant's gateway project (created once
  through `runOnce()`, LiteLLM id `smrt-<tenantId>`). Every write passes
  `auditDetails.operation` (`inference.hosted.provision|revoke|budget|project`)
  to `SecretAuditLog`.
- **Idempotency.** An active grant whose binding is still the stored one is
  returned (`created: false`), its budget synced when it differs. The create
  path runs under `runOnce()` keyed by `(tenantId, userId, generation)`;
  revoke advances the generation (alias `smrt-<tenant>-<user>-g<n>`), so
  re-provisioning mints a new key. A user who replaced the hosted binding
  keeps their config: re-provisioning retires the stale key first.
- **Revoke** restores the prior config when it holds a binding or a mode,
  else writes `{ mode: 'off' }`; a config the user replaced is kept.
- **Budget** is integer micro-dollars (`{ limitMicros, window? }`, `day |
  week | month | year`, default month), converted to the gateway's USD
  `maxLimit` and `1d|7d|30d|365d` only at the admin call. #4760's spend gate
  is the authoritative pre-call check; the gateway budget is defense in depth.
- **Entitlement hook.** `createHostedInferenceEntitlementListener({
  provisioner, users, budgetFor?, defaultBudget? })` structurally matches
  smrt-subscriptions' `EntitlementChangeListener` (register it with
  `registerEntitlementChangeListener()`; the host wraps its webhook write in
  `trackEntitlementChange()`). Gain of `inference.hosted` provisions
  `users(tenantId)` (membership is the host's; later joiners are provisioned
  by calling `provision()`), loss revokes every active grant, a changed grant
  syncs budgets. The plan's budget is the grant's `metadata.budget`
  (`{ limitMicros, window }`). Per-user failures are thrown together after
  all users were tried.
- **Keys.** Never in results, errors (gateway failures carry only the
  operation and error code), audit details, `runOnce()` results or logs.
  Usage rows carry `source: hosted` and `gatewayKeyAlias` (from
  `InferenceTarget.usageTags`). Other processes see a new binding after the
  resolver cache expires; this process is invalidated through
  `invalidateUserInferenceResolvers()`.

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
  transient | refusal | missing-capability`, from error class names, `code`, `retryable` and HTTP
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
  `outcome: failed | partial`, `reason` and the full trail ending `to: null` (reason `unclassified` when a non-routing error ended it),
  then throws `InferenceExhaustedError` (`INFERENCE_EXHAUSTED`).
- Capabilities (#4758): before calling a candidate, a call that sends
  `responseFormat` (JSON) or `tools` checks `context.capabilitiesFor(target)`
  (core's detection, [inference.md](../core/agents/inference.md)). A
  mismatch the caller's `capabilityFallback` option permits (`json: 'text'`,
  `tools: 'drop'`) runs the candidate without the feature, tagged
  `capabilityFallback`; any other is a `missing-capability` substitution and
  the walk advances with no model call. The option never reaches a provider.
  Core's `InferenceUnavailableError` (`reason: 'capability'`) also classifies
  as `missing-capability`. No detector (older core) or no requirement: no
  check. Context limits are core's (single targets only).
- Add a class to `INFERENCE_FAILURE_CLASSES` and a kind to `EXECUTOR_KINDS`
  (`createChainExecutor()` in `fusion.ts` dispatches on it); consumers
  ignore kinds they do not run.

## Fusions

`src/fusion.ts` runs `{ fusion: '<key>' }` tier targets. SMRT ships the
interpreter and the vocabulary, never a fusion: modes are code, fusions are
config. A fusion comes from `inference.fusions.<key>` (app config, wins) or
`defineFusion({ key, mode, seats, gate?, description? })` (process registry
on `globalThis`). A seat is `{ name?, prompt, target, temperature?, output? }`:
`prompt` is a smrt-prompts key whose resolved template (code default,
config, app and tenant overrides, read through `context.db`) is the seat's
system message, so tenant overrides of a seat need nothing new; `target` is
a tier (resolved through the same resolver with the seat's prompt key, so
per-user bindings apply), `{ alias }`, `{ candidates }` or an inline
`{ provider, model }`, never a fusion. Each seat runs through
`createChainClient()`, so chains, classified fallback and (tier seats only)
the ladder apply per seat. `name` defaults to the prompt key and must be
unique.

Example (a consumer's code; SMRT does not ship it):

```ts
definePrompt({ key: 'contracts.skeptic', template: 'List the risks…' });
definePrompt({ key: 'contracts.advocate', template: 'List the benefits…' });
definePrompt({ key: 'contracts.synthesis', template: 'Weigh both reviews…' });
config({ inference: {
  tiers: { best: { fusion: 'contract-review' } },
  fusions: { 'contract-review': {
    mode: 'pair',
    seats: [
      { name: 'skeptic', prompt: 'contracts.skeptic', target: 'good' },
      { name: 'advocate', prompt: 'contracts.advocate', target: { alias: 'frontier' } },
      { name: 'synthesis', prompt: 'contracts.synthesis', target: 'great' },
    ],
    gate: { criteria: 'Both reviews agree on every material risk.',
            sufficientWhen: { choice: 'agree', minConfidence: 0.85 } },
  } },
} });
await contract.do('Summarize this contract', { tier: 'best' }); // unchanged caller
```

- **Modes and call counts** (model calls; a seat's fallback candidates are
  substitutions of that seat, not extra seats): `single` 1 (one seat);
  `pair` 3 (seats 0 and 1 in parallel, then seat 2 merges both outputs,
  labelled by seat and model); `handoff` 2 (seat 0 drafts, seat 1 receives
  the draft and answers). A mode that adds a call is a bug.
- **Gate** (`pair`, `handoff`): one choice question through
  `context.decide()` (core's typed-decision client, the `evaluate()` path)
  over the outputs so far, labels `sufficientWhen.choice` and `continue`.
  The chosen label at `minConfidence` or above skips the remaining stage,
  recorded `skipped`; the answer is then seat 0's output (`pair`: the first
  live one) or the draft. No decision client (`unavailable`) or a decision
  error runs the stage. Its usage row has `seat: 'gate'`, a reserved seat
  name.
- **Failure semantics.** A dead seat never aborts a `pair`: the merge seat
  is told which seat failed and why (class and message). A dead merge or
  handoff answer seat falls back to the first live output, recorded
  `degraded`; the handoff answer seat is told when the draft died. A run
  whose seats all died throws `InferenceFusionError`
  (`INFERENCE_FUSION_FAILED`, `result` holds every seat) with the run
  recorded `failed`, never an empty answer. A seat whose setup fails (prompt
  override read, its tier's resolver) dies like a model failure. A config
  error, a caller abort, or a final seat that already streamed text
  (`partial`) rethrows, after both `pair` seats have settled.
- **JSON**: `output: 'json'` sends `responseFormat: json_object` and parses;
  a seat whose text does not parse keeps it under `raw` (with `parseError`)
  in `FusionSeatResult` and hands the raw text on, labelled. A candidate
  without JSON mode runs the seat in text on that recovery path
  (`capabilityFallback: { json: 'text' }`, #4758) instead of being skipped.
- **Caller options**: generation options (`responseFormat`, `tools`,
  `onProgress`, …) reach the final seat only; `signal` / `timeout` reach every
  seat; `history` is the seat's instructions. `onFusionResult(result)`
  receives the structured `FusionRunResult`. Only `message()` runs a fusion.
- **Record**: every seat's usage row carries `runId`, `fusionKey`, `seat`
  and the seat's prompt tags; `context.recordRun()` writes one
  `_smrt_ai_runs` row (`ok | degraded | failed`; a seat is degraded when it
  died or answered through a substitution) with identities and totals only
  (`../core/agents/ai-usage.md`). `smrt ai:usage --by fusion` totals runs.
- **Validation**: `findInferenceConfigIssues()` names structural offenders
  by path (`fusion-invalid`, `fusion-unknown`, `fusion-nested`); an
  unregistered seat prompt key is a load error (`fusion-prompt-unknown`) from
  `validateInferenceConfig()`, the resolver, the executor and
  `defineFusion()`, but not the doctor (it runs without the app's prompts).
- Seat prompts resolve through `@happyvertical/smrt-prompts` (a dependency;
  never a peer, #1582), imported by a variable specifier from this package
  (strict layouts find it; bundlers do not follow it, so the root stays browser-safe),
  then core's `importOptionalDependency()` (a module registered with
  `registerOptionalDependency()` in bundled builds).
  `setFusionPromptResolver()` replaces it.
- **Tenant-level fusions are deferred** to #4754's allow-list: a fusion
  multiplies hosted model spend per call, so a tenant must not be able to
  define or rebind one until bindings have a tenant allow-list. v1 reads
  fusions from app config and code only.

## Doctor (`src/node.ts`)

Per tier, alias and fusion (structure only): provider recognized (AI SDK provider list or preset id),
key variable present (a provider's default variable only warns: a
same-provider target inherits the configured key), model named (warns),
alias resolvable, cycle-free. `probe` GETs `/models` (OpenAI-compatible,
Anthropic, Gemini) or Ollama `/api/tags` with a 3 s timeout, sending the key
only to its own endpoint. A binding errors when its config is invalid or no
candidate can answer; one bad candidate in a working chain warns. Keys never
appear in the report. With `probe` each candidate also reports its
capabilities and their source (#4758, `formatInferenceCapabilities()`): the
listing's context length, `supported_parameters` and input modalities
(`inferenceCapabilitiesFromModelListing()`) are the `probe` layer; the SDK
`provider` layer only through the `sdkCapabilities` option (the doctor builds
no SDK clients).

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
