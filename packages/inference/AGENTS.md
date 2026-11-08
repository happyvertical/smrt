# smrt-inference

Binding behavior for core's inference tiers (epic #4749). Core owns the names
and the seam ([core inference.md](../core/agents/inference.md)); this package
owns alias chains, classified fallback, ladder degradation and
`smrt doctor --ai` (#4752), and the fusion interpreter (#4753). The
settings panel (#4754) builds on the executor and the doctor here.

## Entries

- Root (browser-safe): importing it calls `registerInference()`, which sets
  the executor (`alias`, `candidates`, `fusion`) and a validating resolver
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
- Add a class (#4758 `missing-capability`) to `INFERENCE_FAILURE_CLASSES`
  and a kind to `EXECUTOR_KINDS` (`createChainExecutor()` in `fusion.ts`
  dispatches on it); consumers ignore kinds they do not run.

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
  in `FusionSeatResult` and hands the raw text on, labelled.
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
appear in the report.

## Validation

```bash
pnpm --filter @happyvertical/smrt-inference test
pnpm --filter @happyvertical/smrt-inference typecheck
pnpm --filter @happyvertical/smrt-inference build
```
