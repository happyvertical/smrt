# smrt-inference

Binding behavior for core's inference tiers (epic #4749). Core owns the names
and the seam ([core inference.md](../core/agents/inference.md)); this package
owns alias chains, classified fallback, ladder degradation and
`smrt doctor --ai` (#4752). Fusions (#4753) and the settings panel (#4754)
build on the executor and the doctor here.

## Entries

- Root (browser-safe): importing it calls `registerInference()`, which sets
  the chain executor (`setInferenceExecutor()`) and a validating resolver
  (`setInferenceResolver()`). The resolver binds nothing: it validates chain
  config, then defers to a resolver registered earlier (#4666 per-user
  bindings) or to core's built-in config resolution. No aliases and no chain
  targets means no change in behavior. `browser-safe.test.ts` holds the graph
  free of `node:`, the AI SDK and smrt-config (no models, so the bundle-gate
  fixture does not cover it).
- `./node`: `checkInferenceBindings()`, `probeInferenceCandidate()`,
  `formatInferenceDoctorReport()`; the CLI's `doctor --ai` and #4754's test
  connection call these.

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
  failure. Aborts and unclassified errors stop the walk and are rethrown (an
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

## Validation

```bash
pnpm --filter @happyvertical/smrt-inference test
pnpm --filter @happyvertical/smrt-inference typecheck
pnpm --filter @happyvertical/smrt-inference build
```
