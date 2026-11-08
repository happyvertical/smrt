# Inference tiers and the binding resolver seam (#4750)

Source: `src/inference.ts`, `SmrtClass.getAiClient(tier?)` in `src/class.ts`,
`SmrtObject.prepareAiOperation()` in `src/object.ts`. Epic: #4749.

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
concrete tier answered by another tier: v1 has no substitutions, and #4749
requires degradation to be recorded, never silent.

The #4666 per-user resolver is an `InferenceResolver` returning a tier →
target binding map, not a single `AIClientOptions`. Later children extend
`InferenceTarget` (optional `kind`, `alias`, `candidates`, `fusion`) without
breaking v1; consumers ignore members they do not understand.

## Clients and calls

- `getAiClient(tier, { latency, promptKey, resolution })` builds a client per
  resolved `(provider, model, baseUrl)`, keyed again by credential so two
  users' keys never share a client. A target equal to the configured identity
  returns the configured client. Absent fields inherit from the configured
  client through `mergeAIConfigObjects`; another provider drops the configured
  key, base URL and model. Endpoint and key are owned together and an
  unbound pair fails closed before the SDK can fill it from its own
  environment: a target `baseUrl` (other than the configured one) must carry
  its own `apiKey`; a target `apiKey` drops the configured `baseUrl` and must
  name its own while `<PROVIDER>_BASE_URL` is set; only a provider's default
  endpoint falls back to that provider's own key variable.
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
`src/__tests__/class-inference-tiers.test.ts`.
