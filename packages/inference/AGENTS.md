# smrt-inference

Binding behavior for core's inference tiers (epic #4749). Core owns the names
and the seam ([core inference.md](../core/agents/inference.md)); this package
owns alias chains, classified fallback, ladder degradation and
`smrt doctor --ai` (#4752), the fusion interpreter (#4753), the settings
panel with layered binding storage (#4754), per-user and per-tenant
bindings (#4756), candidate capability checks (#4758), and hosted
provisioning and the spend gate (#4759, #4760). App-author guide:
[docs/content/inference.md](../../docs/content/inference.md).

## Entries

- Root (browser-safe): importing it calls `registerInference()`, which sets
  the executor (`alias`, `candidates`, `fusion`) and a validating resolver
  (`setInferenceResolver()`). The resolver binds nothing: it validates chain
  config, then defers to a resolver registered earlier (#4756 per-user
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
- `./gate` (Node-only, #4760): the hosted spend gate and kill switch
  (below). `browser-safe.test.ts` keeps it off the root graph.

## Per-user and per-tenant bindings (#4756)

`createUserInferenceResolver()` resolves per tier: the user's stored config,
the tenant's, `fallback`, the app `inference` block, then the configured
client; every resolution carries `target.source` (`byo | local | hosted |
app`, the `source` usage tag). Keys live only in the smrt-secrets type
`inference.provider-config` (`context = tenantId`), every stored binding is
self-contained (own `baseUrl` + `apiKey`, or a preset), the user layer
applies only to a principal of that tenant, and agents pass `userId: null`
(tenant layer only). The stored config also carries `mode` (#4757).
Details: [agents/resolver.md](agents/resolver.md).

## Resolver composition

One resolver is registered, outermost first: the #4752 validating wrapper,
the #4756 user resolver, its `fallback`, then core's config resolution.
Hosts using the #4754 override table pass
`createInferenceOverrideResolver({ db })` as that `fallback`:
`registerUserInferenceResolver(createUserInferenceResolver({ db, fallback:
createInferenceOverrideResolver({ db }) }))`. Order per tier: user stored
binding, tenant stored binding, allowed tenant override row, app override
row, `inference` config, configured client. Keys are stored once, in
`inference.provider-config`: the host turns #4754's origin-bound
`bindInferenceKey()` record into a self-contained binding with
`inferenceProviderConfigFromKey(record, { model })` and writes it through
the user resolver's `write(level, config)`; never a second secret type.

## Hosted inference (#4759, #4760)

`./node` provisions per-user gateway keys through `ai.admin` of the
`bifrost` / `litellm` provider (`SMRT_INFERENCE_HOSTED_*`, read once), storing
the key only in the user's `inference.provider-config` (`source: 'hosted'`).
Budget update and key delete wait on happyvertical/sdk#1494 (feature-detected;
revoke ends local use first and records owed deletions). `./gate`'s
`registerHostedInferenceGate({ killSwitch, spend })` is core's
`InferenceGate`: kill switch `inference.hosted.enabled` (a global DISABLE
always wins), tenant, entitlement, then plan spend caps; a block throws
`InferenceUnavailableError` (`entitlement`) and writes a `blocked` usage row.
Details: [agents/hosted.md](agents/hosted.md).

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
  `allowPartial` returns the text. A hosted-gate block (`AI_UNAVAILABLE`
  from `clientFor()`, #4760) stops the walk and records nothing (core wrote
  the `blocked` row). A step whose target names a `source` (a ladder step's
  resolved binding) records that source over the chain's, so hosted spend
  meters as hosted; `expandTarget()` hands a chain's own `source` to its
  candidate steps, so a hosted chain reached on a ladder step is gated in
  `clientFor()` and meters as hosted too. A `stream()` consumer that stops reading
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

## Fusions (#4753)

`{ fusion: '<key>' }` tier targets run consumer-defined fusions (`single` 1
call, `pair` 3, `handoff` 2) from `inference.fusions` (wins) or
`defineFusion()`. SMRT ships the interpreter, never a fusion. Seats are
smrt-prompts keys run through `createChainClient()`; a dead seat never
aborts a `pair`, all seats dead throws `InferenceFusionError`; each run writes
one `_smrt_ai_runs` row. Fusions are defined at app scope only; a tenant
may bind a tier to an allow-listed fusion, never define one. Details:
[agents/fusions.md](agents/fusions.md).

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

`./svelte` `InferenceSettingsPanel`, `./server` `InferenceSettingsService` /
`InferenceOverrideService` / `createInferenceOverrideResolver()`, `./models`
the `_smrt_inference_overrides` model (ships through `smrt db:migrate`).
Keys go to smrt-secrets through the host and are bound to their endpoint's
origin; user choices are the smrt-preferences kind `inference`; app/tenant
bindings are override rows, tenants limited to the app row's allow-list and
the `tenantTargetPolicy` hook. The app's transcript setting (#4781) is the
app-only `transcripts` row, editable in the panel only with `appEditable`,
applied as core's transcript app settings layer; the Usage tab shows
transcript counts and links to a host route, never content. Details: [agents/settings.md](agents/settings.md),
consumer guide [docs/content/inference-settings.md](../../docs/content/inference-settings.md).

## Validation

```bash
pnpm --filter @happyvertical/smrt-inference test
pnpm --filter @happyvertical/smrt-inference test:postgres   # hosted provisioning on PostgreSQL (advisory lock, runOnce)
pnpm --filter @happyvertical/smrt-inference typecheck
pnpm --filter @happyvertical/smrt-inference build
```
