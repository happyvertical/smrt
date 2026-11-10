# Fusions (`src/fusion.ts`, #4753)

`src/fusion.ts` runs `{ fusion: '<key>' }` tier targets. SMRT ships the
interpreter and the vocabulary, never a fusion: modes are code, fusions are
config. A fusion comes from, highest first (each replaces a lower one whole):
the registered resolver's stored layer through core's
`context.lookupFusion(key)` (#4800; the override resolver's app rows),
`inference.fusions.<key>` (app config), or
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
  (`../../core/agents/ai-usage.md`). `smrt ai:usage --by fusion` totals runs.
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
- **Fusions are app-scope only.** A fusion multiplies hosted model spend
  per call, so a tenant never defines or redefines one; with #4754's
  allow-list a tenant may bind a tier to a listed fusion (`fusion:<n>`).
- **Stored fusions (#4800).** Core hands the executor
  `context.lookupFusion(key)`: the instance's (or registered) resolver's
  optional `lookupFusion(key, request, context)`, then the merged
  `inference.fusions`; `undefined` falls to the registry. Without it (older
  cores) the executor reads config, then the registry, and validates at bind
  time; with it the lookup starts at bind time and an unknown or invalid
  fusion fails the first call before any seat runs (nothing recorded). Every
  definition, whatever its source, is validated before it runs (structure
  against the call's aliases, every seat prompt key); a resolver's answer
  fails under path `resolver.fusions.<key>`. The #4752 validating wrapper
  and the #4756 user resolver forward `lookupFusion` to their base /
  `fallback` (stored user and tenant configs never define a fusion).
