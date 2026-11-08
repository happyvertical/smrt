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
`model`/`params` only for `single` targets. Later kinds (`fusion`, #4753)
register into the same seam; consumers ignore members they do not
understand. Browser-safe presets (#4674): `src/inference-presets.ts`.

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
- Untiered calls (`getAiClient()`, `do()` without `tier`) keep the configured
  client and never consult the resolver (the parity contract); a per-user
  binding reaches objects through `tier` (`auto` included).

## Raw clients and binding source (#4756)

`src/inference-target.ts`. `bindInferenceTarget(base, target, owner)` is the
one implementation of the pair rules above; `getAiClientForTarget()` uses it.
`resolveInferenceTarget({ tier = 'auto', base, tenantId, className,
promptKey, appBindings, usage })` resolves through the registered resolver
and returns `{ options, resolution, bound, source, usageTags }` for a site
that calls `getAI()` itself: `base` unchanged when the tier is unbound or the
target is a chain (raw clients cannot run one), else the target bound over
`base` (the caller's `onUsage` kept). `userId: null` marks a client shared beyond one user (no user binding
applies). `appBindings: false` lets only a
resolver resolution whose `source` is not `app` replace `base`: sites whose
`base` is their own explicit config (agent `ai`, a prompt's model) keep it
against app tier bindings. `usage` attaches the #3077 recorder with
`usageTags`: tier tags plus `source` when bound, only `{ source: 'app' }`
when not. Per-call `model` options must follow the bound model.

`InferenceTarget.source` (`INFERENCE_TARGET_SOURCES`: `byo | local | hosted
| app`) is never identity; `inferenceUsageTags()` adds it as the `source` tag,
so tier calls record it too. The per-user resolver lives in
[smrt-inference `./resolver`](../../inference/AGENTS.md). Converted raw
sites: agents (`resolveAgentAIClientOptions`), chat (assistant default
factory, resolved inside the route principal's tenancy context, recorder
without db because the turn's request db does not outlive it; dev text
routes via `devAIClientOptions()`, tenant-less), languages (translation job), projects
(`Issue.incorporateFeedback` provider path), images (`ImageCategorizer`
generated route), cli (`smrt kitchen`). Left: image generation (content
thumbnails, images editor/deriver; tiers bind text models), ingestion vision
(a host-pinned provider identity in a child process), images typed decisions
and the dev photo-setup route (vision / decision providers).

## Inference mode and `AI_UNAVAILABLE` (#4757)

`src/inference-availability.ts` (browser-safe, also `./inference-availability`):
`InferenceMode = 'byo' | 'local' | 'hosted' | 'off'`, `InferenceStatus =
{ available, mode, reason?, tier? }` (never a key, endpoint or model), and
`InferenceUnavailableError` (`SmrtError` code `AI_UNAVAILABLE`, category
`configuration`, `retryable: false`, `reason: off | unconfigured |
entitlement | capability`; `isInferenceUnavailableError()` matches by code
across core copies). `entitlement` is reserved for the hosted gate (#4760)
and `capability` for capability detection (#4758); nothing raises them yet.
`off` and `unconfigured` always report mode `off`.

- **Where it is thrown.** `getAiClient()`, before any client is built, so
  `is()`, `do()`, `describe()` and `evaluate()`'s generative route throw it
  (the typed-decision route is untouched, #3158). `is()` never turns it into
  `false`. A tier call throws the resolution's `unavailable` reason; a tier
  or untiered call with no provider anywhere (empty target, no configured
  client) throws `unconfigured` (formerly a plain `Error` "does not have an
  AI client configured"). `resolveInferenceTarget()` throws a resolution's
  `unavailable` for raw `getAI()` sites. Nothing ran, so nothing reaches
  `_smrt_ai_usage` or the usage handlers.
- **Resolver contract.** `InferenceResolution` gains optional `mode` and
  `unavailable` (validated). `InferenceResolver.mode?(request)` is optional
  and is the only resolver call an untiered call makes
  (`resolveInferenceMode()`): it returns `{ mode, unavailable? }` when a mode
  is stored. `unavailable` stops untiered calls too; any other stored mode is
  the principal's explicit choice and routes untiered calls (`getAiClient()`,
  `prepareAiOperation()`, the untiered probe) through `auto`, so a `local` or
  keyless `byo` choice never runs on the app's configured client. No stored
  mode, or a resolver without `mode()` (the built-in one), keeps the parity
  contract. `SmrtClass.inferenceUserScope()` returns `null` for instances
  whose client serves many users (`Agent`): their tier resolutions and mode
  checks send `userId: null`, so only the tenant layer applies. The per-user resolver stores
  the mode beside the provider config ([smrt-inference](../../inference/AGENTS.md)).
- **Reported mode.** `inferenceModeForTarget()`: the resolution's `mode`, else
  the target `source` (`byo | local | hosted`), else for app config and the
  configured client `local` (Ollama or a loopback endpoint) or `hosted`
  (`source` stays `app`).
- **Probes.** `getInferenceStatus({ tier?, tenantId?, userId: null?,
  className?, resolver?, configured? })` / `isInferenceAvailable()`
  (`src/inference-status.ts`), and the instance methods
  `getInferenceStatus({ tier? })` / `isInferenceAvailable()` on `SmrtClass`,
  resolve exactly as a call would without calling a model or recording
  usage. A chain target counts as available.
- **Endpoints.** `createInferenceStatusHandler({ tier?, tierParam?, run? })`
  is a SvelteKit `GET` (`export const GET = createInferenceStatusHandler()`):
  `?tier=` (400 when unknown), `cache-control: no-store`, a resolver failure
  is a bare 500. `run(event, probe)` enters the host's principal context when
  its handle hook has not. The generated REST surface serves the same body at
  `GET {basePath}/_inference` (`generators/inference-status-route.ts`),
  running `authMiddleware('_inference', 'status')` when configured.
- **Feature flags.** To gate UI with smrt-features, map the status in the
  host's flag evaluation (for example a flag whose resolver returns
  `(await getInferenceStatus()).available`); SMRT ships no AI flag.
- **Consumers.** Agents end the run `skipped` (agents AGENTS); chat answers a
  structured `ai_unavailable` 503 (chat AGENTS).

Tests: `src/__tests__/issue-4757-inference-unavailable.test.ts`,
`src/__tests__/issue-4756-inference-target.test.ts`,
`src/__tests__/inference-tiers.test.ts`,
`src/__tests__/class-inference-tiers.test.ts`,
`src/__tests__/inference-executor-seam.test.ts`.
