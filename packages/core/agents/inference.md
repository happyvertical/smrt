# Inference tiers and the binding resolver seam (#4750, #4752, #4753)

Source: `src/inference.ts`, `SmrtClass.getAiClient(tier?)` in `src/class.ts`,
`SmrtClass.prepareAiOperation()` (objects and collections) in `src/class.ts`.
Epic: #4749.

## Vocabulary

- `INFERENCE_TIERS = ['cheap', 'good', 'great', 'best']`, ordered cheapest
  first (`compareInferenceTiers`). `InferenceTierRequest` adds `auto`.
  `fast` is deliberately not a tier: latency is a separate hint,
  `InferenceLatency = 'interactive' | 'background'`, that a binding may honor.
- `auto` never calls a model. It resolves to `inference.defaultTier`, else
  `good` (`DEFAULT_INFERENCE_TIER`).

## Config

`config({ inference })`, smrt.config `smrt.inference`, and the instance
`inference` option all take `InferenceConfig = { defaultTier?, tiers? }`, where
each tier binds an `InferenceTarget` (`provider`, `model`, `baseUrl`, `apiKey`,
`params`, `latency`; all optional). Precedence, lowest first: smrt.config <
`config()` < env (`SMRT_INFERENCE_DEFAULT_TIER`,
`SMRT_INFERENCE_<TIER>_PROVIDER` / `_MODEL`) < instance options. A tier's
target is replaced whole by the highest layer that binds it, never
field-merged, so a key cannot follow a target to another layer's provider.

**Unconfigured parity is a contract.** With no config and no resolver every
tier resolves to `{ target: {}, via: 'default' }`, which `getAiClient(tier)`
maps to the configured client; `getAiClient()` without a tier is unchanged,
and calls without `tier` send byte-identical `ai.message()` options.

## Resolver seam

`setInferenceResolver(resolver | undefined)` / `getInferenceResolver()` hold
one process-wide `InferenceResolver` on `globalThis` (HMR and duplicate core
copies). An instance `inference` option that has `resolve()` replaces it for
that instance. `resolve(request, { config, resolveFromConfig })` receives
`{ tier, latency?, tenantId?, userId?, className?, promptKey? }` and returns
`{ tierResolved, target, via }`, or `undefined` to defer to the built-in
config resolution. `resolveInference()` validates the result and rejects a
concrete tier answered by another tier: resolvers bind, only the executor
degrades, and #4749 requires every degradation to be recorded.

The #4666 per-user resolver is an `InferenceResolver` returning a tier →
target binding map, not a single `AIClientOptions`.

## Chain kinds and the executor seam (#4752)

`InferenceTarget.kind` selects the shape (`inferenceTargetKind()`: explicit
`kind`, else `alias` when `alias` is set, else `candidates` when a list is
set, else `single`). `InferenceConfig` adds `aliases` (each replaced whole by
the highest layer) and `degrade`. Core runs only `single`; any other kind
goes to the executor registered with `setInferenceExecutor()` (behavior in
[smrt-inference](../../inference/AGENTS.md)), and a chain target with no
executor throws (`inferenceExecutorFor()`) rather than falling back to the
configured client. `getAiClient(tier)` hands the executor an
`InferenceExecutionContext`: the request and resolution, merged config,
`minimumTier`, `allowPartial`, `clientFor(target)` (a `single` client with
the pair rules and the usage pipeline), `resolveTier(tier)`, and
`recordUsage()` (a zero-token row through the same usage handlers, for a call
nothing answered). Pair-rule refusals throw `InferenceBindingError`
(`INFERENCE_TARGET_UNBOUND`) so an executor classifies them by code. `AiOperationOptions.minimumTier` / `allowPartial` are
stripped before `ai.message()`; `prepareAiOperation()` applies a target's
`model`/`params` only for `single` targets. `fusion` (#4753) registers into the
same seam; consumers ignore members they do not understand. Browser-safe presets (#4674): `src/inference-presets.ts`.

## Fusions (#4753)

`kind: 'fusion'` (`{ fusion: '<key>' }`, read as that kind without `kind`)
binds a tier to a consumer-defined fusion; the registered executor runs it
([smrt-inference](../../inference/AGENTS.md#fusions)). Core owns the
vocabulary only: `INFERENCE_FUSION_MODES = ['single', 'pair', 'handoff']`,
`InferenceFusionDefinition { mode, seats, gate?, description? }`,
`InferenceFusionSeat { name?, prompt, target, temperature?, output? }`,
`InferenceFusionGate { criteria, sufficientWhen: { choice, minConfidence } }`
and `InferenceConfig.fusions` (app-level, replaced whole per key by the
highest layer). SMRT ships no fusion.

The executor context adds what a fusion needs, all optional for other
executors: `request` now carries the instance's `className` / `tenantId`;
`resolveTier(tier, { promptKey })` resolves a seat's tier with the seat's
prompt key (so prompt-scoped and per-user resolvers apply per seat); `db`
(read-only, for stored prompt overrides); `decide(request, { usageTags,
signal })`, the instance's typed-decision client exactly as `evaluate()`
uses it (`undefined` without one), recording its usage row with the given
tags; `recordRun(record)`, the `_smrt_ai_runs` writer
([ai-usage.md](ai-usage.md#run-records-_smrt_ai_runs-4753)); and
`observeUsage(runId, listener)`, which feeds the run's normalized usage
events back for per-seat totals. Seat usage rows carry `runId` (lifted to
`run_id`), `fusionKey` and `seat` tags.

## Clients and calls

- `getAiClient(tier, { latency, promptKey, resolution })` builds a client per
  resolved `(provider, model, baseUrl)`, keyed again by credential so two
  users' keys never share a client. A target equal to the configured identity
  returns the configured client. Absent fields inherit from the configured
  client through `mergeAIConfigObjects`; another provider drops the configured
  key, base URL and model. Endpoint and key travel as an explicit pair, and
  an unbound pair fails closed before `getAI()` or the provider SDK can fill
  it from their environment (`HAVE_AI_*`, `OPENAI_*`): a target `baseUrl`
  (other than the configured one) needs its own `apiKey`, and a target
  `apiKey` needs its own `baseUrl`. A target on another provider with neither
  uses that provider's default endpoint and key variable, refused while
  `HAVE_AI_BASE_URL`/`HAVE_AI_API_KEY` are set. Real-SDK transport test:
  `class-inference-tiers-transport.test.ts`.
  Failed builds are evicted. `@happyvertical/ai` stays a dynamic import
  (#2894). An injected client keeps serving model-only targets (the model
  goes per call); a target naming an endpoint must name a provider.
- `AiOperationOptions.tier` / `latency` (and the same keys on
  `EvaluateOptions`) route `do()`, `is()`, `describe()` and `evaluate()`'s
  generative route. The typed-decision route ignores them (#3158).
  `promptKey` rides along to the resolver and is stripped from the call.
  `prepareAiOperation()` resolves once, applies `target.params` and
  `target.model` under the caller's options, and merges `tierRequested` /
  `tierResolved` over the caller's `usageTags`; the SDK lands them in
  `_smrt_ai_usage.tags`. Subclasses that call `ai.message()` themselves use
  `prepareAiOperation()` so `tier` never reaches the provider.
- Prompts: see `packages/prompts/AGENTS.md` (tier profile names).

Tests: `src/__tests__/inference-tiers.test.ts`,
`src/__tests__/class-inference-tiers.test.ts`,
`src/__tests__/inference-executor-seam.test.ts`,
`src/__tests__/issue-4753-ai-runs.test.ts`.
