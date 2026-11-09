---
title: Inference tiers, bindings and usage
---

# Inference tiers, bindings and usage

Every s-m-r-t object can call a model: `is()`, `do()`, `describe()`,
`evaluate()`, prompts and agents. This guide is for the app author who
decides which model answers those calls, who else may change that, what
happens when a model fails, and how to see how each model does. Each section
is short and links to the package document that holds the full contract.

An app with one provider and no `inference` config needs none of this: every
call runs on the one configured client, exactly as before. Read on when you
want a second model, a fallback, user or tenant choice, or hosted inference.

## Vocabulary

These words mean one thing everywhere in the s-m-r-t docs.

| Term | Meaning |
| --- | --- |
| **tier** | The quality a call asks for: `cheap < good < great < best`, plus `auto`. Never a model name. |
| **target** | What a tier is bound to: one model, an alias, a candidate list, or a fusion. |
| **binding** | A tier → target assignment made by some layer (app config, a tenant, a user). |
| **candidate** | One entry of a chain: a provider and model, a preset and model, or another alias. |
| **chain** | An ordered candidate list, walked until one answers. |
| **alias** | A named chain (`frontier`), defined once and bound to any tier. |
| **substitution** | A recorded step from one candidate (or tier) to the next, with its reason. |
| **fusion** | A consumer-defined multi-call recipe over prompt keys, run as one call. |
| **seat** | One prompt + target inside a fusion. |
| **mode** | A principal's stored choice: `byo`, `local`, `hosted` or `off`. |
| **source** | Where a binding came from: `byo`, `local`, `hosted` or `app`. Recorded on every usage row. |
| **call** | One model request; one `_smrt_ai_usage` row. |
| **run** | One fusion execution; one `_smrt_ai_runs` row plus one usage row per seat call. |
| **outcome** | A label recorded later about a call or a run (`good`, `wrong`, a score). |
| **transcript** | The stored, redacted text of a call, opt-in; one `_smrt_ai_transcripts` row. |

## 1. One provider

Configure the one client as you always have: `SMRT_AI_PROVIDER`,
`SMRT_AI_API_KEY`, `SMRT_AI_MODEL` (and `SMRT_AI_BASE_URL` for a gateway or
local server), or `ai` in `smrt.config.ts` / `config({ ai })`. The resolution
order is in the [smrt-config README](./packages/config.md). With nothing
else, every tier is bound to that client, so `tier: 'great'` and no tier run
on the same model.

```bash
smrt doctor --ai          # offline: providers, key variables, models, aliases, cycles
smrt doctor --ai --probe  # also asks each endpoint for its model list
```

`smrt doctor --ai` checks each tier, alias and fusion binding offline: the
provider is known, its key variable is set, a model is named, aliases
resolve and do not loop. It exits 1 when a binding cannot resolve. `--probe`
asks each endpoint for its model list (key sent only to its own endpoint)
and reports the model's JSON, tool and context capabilities. Keys never
appear in its output.

To let people change the provider, key and model from your app, mount
`InferenceSettingsPanel` from `@happyvertical/smrt-inference/svelte` in your
settings page. Its default view is the whole screen a one-provider app
needs; the tier ladder, aliases and fusions stay behind "Advanced". Keys go
from the panel to your server action and into smrt-secrets, never back to
the browser. Wiring: [Inference settings](./inference-settings.md).

## 2. Tiers

Ask for quality, not a model. `tier` works on `is()`, `do()`, `describe()`
and `evaluate()`'s generative route:

```ts
await article.is('is about local politics', { tier: 'cheap' });
await article.do('Write a headline', { tier: 'good', latency: 'interactive' });
```

- `auto` resolves to `inference.defaultTier` (default `good`) and records
  `auto → good`; it never consults a model to choose.
- `latency: 'interactive' | 'background'` is a hint a binding may honor.
  `fast` is not a tier: a cheap model is not always a fast one.
- A call without `tier` keeps the configured client and never consults a
  binding, unless the principal has chosen a mode (section 5).
- Prompts declare a tier as their profile: `definePrompt({ key, template,
  ai: { profile: 'good' } })`. Every framework prompt already declares one
  (#4755): classification `cheap`, summaries and translations `good`,
  synthesis over user content `great`, nothing `best`. Tenants change a
  prompt's tier through prompt overrides; see the
  [smrt-prompts README](./packages/prompts.md).
- Bind tiers in config, or per tier with `SMRT_INFERENCE_<TIER>_PROVIDER` /
  `_MODEL` and `SMRT_INFERENCE_DEFAULT_TIER`.
- When every candidate of a tier fails, the call moves down to the next
  cheaper tier and records the step. It never moves up. Pin a floor with
  `minimumTier` on the call or `ai: { minimumTier }` on the prompt; set
  `inference.degrade: false` to stop degrading entirely.

Contract: [core inference.md](https://github.com/happyvertical/smrt/blob/main/packages/core/agents/inference.md).

## 3. Aliases and fallback

Install `@happyvertical/smrt-inference` and import it once at startup; the
import registers the executor that walks chains. An alias is an ordered
chain of candidates; a tier bound to it tries them in order.

A failed candidate is classified, never by message text, and the walk moves
on:

| Class | Typical cause | What happens |
| --- | --- | --- |
| `quota` | rate limit, exhausted credit | next candidate |
| `credential` | bad or missing key, unbound endpoint | next candidate |
| `missing-model` | renamed or retired model | next candidate |
| `transient` | 5xx, timeout | one retry after a short jitter, then next |
| `refusal` | refusal finish with nothing streamed | next candidate |
| `missing-capability` | the call needs JSON or tools the model lacks | next candidate, no model call |

Other client errors (a bad request, context length) are not routing
failures and reach the caller. Text already streamed is never continued by
another model.

Each step is a **substitution** `{ from, to, reason }`. The answering call's
usage row carries `tierRequested`, `tierResolved` (the tier that answered)
and the `substitutions` list. A call nothing could answer leaves one
zero-token row with the full trail and throws `InferenceExhaustedError`
(`INFERENCE_EXHAUSTED`). Contract:
[smrt-inference AGENTS](https://github.com/happyvertical/smrt/blob/main/packages/inference/AGENTS.md),
[README](./packages/inference.md).

## 4. Fusions

A fusion runs several calls as one: two models review independently and a
third weighs them, or one drafts and another answers. SMRT ships the
interpreter and three modes; you define every fusion. Callers do not change:
they ask for a tier, and the tier is bound to the fusion.

| Mode | Seat calls | Shape |
| --- | --- | --- |
| `single` | 1 | one seat |
| `pair` | 3 | seats 0 and 1 in parallel, seat 2 merges both |
| `handoff` | 2 | seat 0 drafts, seat 1 answers from the draft |

A seat is a smrt-prompts key (its resolved template is the seat's
instructions, so tenant prompt overrides apply) plus a target: a tier, an
alias, a candidate list or one model, never another fusion. Each seat runs
through its own chain, so one seat's fallback is a substitution of that
seat, not an extra seat. The seat-call count is fixed; actual requests can be
higher: a fallback candidate or a `transient` retry is another request for
that seat, and a gate adds one decision call.

- **Decision gate** (`pair`, `handoff`): one yes/no-style question through
  the typed decision client `evaluate()` uses. When the chosen label clears
  `minConfidence`, the remaining stage is skipped and recorded `skipped`.
  With no decision client the stage always runs and no gate call is made.
  So a gated `pair` makes two seat calls and the gate call when the gate
  skips the merge, and four calls when it does not.
- **Failure semantics.** A dead seat never aborts a `pair`: the merge seat is
  told which seat failed. A dead merge or answer seat falls back to the
  first live output and the run is recorded `degraded`. When every seat
  dies the call throws `InferenceFusionError` (`INFERENCE_FUSION_FAILED`);
  an empty answer is never returned.
- Each run writes one `_smrt_ai_runs` row (`ok | degraded | failed`) and one
  usage row per seat call, all sharing the `runId`.

### Worked example

An app with OpenAI and Anthropic keys (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`), all four tiers bound, two aliases, and an
adversarial review on `best`:

```ts
import '@happyvertical/smrt-inference';
import { config } from '@happyvertical/smrt-core';
import { definePrompt } from '@happyvertical/smrt-prompts';

definePrompt({ key: 'review.skeptic', template: 'List every flaw and risk in the input.' });
definePrompt({ key: 'review.advocate', template: 'Make the strongest case for the input.' });
definePrompt({ key: 'review.judge', template: 'Weigh both reviews and give a verdict.' });

config({
  ai: { provider: 'openai', model: 'gpt-5-mini' }, // the configured client
  inference: {
    defaultTier: 'good',
    aliases: {
      frontier: {
        candidates: [
          { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          { provider: 'openai', model: 'gpt-5' },
        ],
      },
      workhorse: {
        candidates: [
          { provider: 'openai', model: 'gpt-5-mini' },
          { provider: 'anthropic', model: 'claude-haiku-4-5' },
        ],
      },
    },
    tiers: {
      cheap: { provider: 'openai', model: 'gpt-5-nano' },
      good: { alias: 'workhorse' },
      great: { alias: 'frontier' },
      best: { fusion: 'adversarial-review' },
    },
    fusions: {
      'adversarial-review': {
        mode: 'pair',
        seats: [
          { name: 'skeptic', prompt: 'review.skeptic', target: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
          { name: 'advocate', prompt: 'review.advocate', target: { provider: 'openai', model: 'gpt-5' } },
          { name: 'judge', prompt: 'review.judge', target: { alias: 'frontier' } },
        ],
        gate: {
          criteria: 'Both reviews reach the same verdict.',
          sufficientWhen: { choice: 'agree', minConfidence: 0.85 },
        },
      },
    },
  },
});

await proposal.do('Review this proposal', { tier: 'best' }); // 3 seat calls (+ gate), 1 run row
await proposal.do('Summarize it', { tier: 'good' });         // gpt-5-mini, then Claude Haiku
```

If OpenAI rate-limits the `good` call, Claude Haiku answers and the usage row
records `{ from: 'openai/gpt-5-mini', to: 'anthropic/claude-haiku-4-5',
reason: 'quota' }`. If the skeptic seat dies, the judge is told and the run is
`degraded`. Contract:
[fusions.md](https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/fusions.md).

## 5. Who decides what

Bindings are layered. Per tier, highest first: the user's stored binding,
the tenant's stored binding, an allowed tenant override row, the app
override row, the `inference` config, then the configured client. Each
layer replaces a target whole, so a key never follows a target to another
layer's provider.

- **App** (you): the `inference` config, plus app override rows written from
  the settings panel (`_smrt_inference_overrides`, created by
  `smrt db:migrate`). Aliases and fusions are defined only here. A fusion
  defined only in the settings panel does not reach the executor yet and
  fails `fusion-unknown` (#4800); define fusions in config or with
  `defineFusion()` until then.
- **Tenant**: may bind a tier only to a target on the app row's
  **allow-list** (`alias:frontier`, `model:openai/*`); no list means
  tenants bind nothing. Narrowing the list disables existing tenant rows.
- **User**: a stored provider config (their own key, a local server, or a
  hosted key) applies only inside their own tenant.
- **Keys** live only in smrt-secrets (`inference.provider-config`), written
  by your server action, bound to the origin of the endpoint they were
  entered for, never sent anywhere else and never read back by the browser.
  User choices (mode, provider, model, default tier) are smrt-preferences.
- Agents serve many users, so they read only the tenant layer and never a
  user's binding.

Register the composition once at startup:

```ts
import { registerUserInferenceResolver, createUserInferenceResolver } from '@happyvertical/smrt-inference/resolver';
import { createInferenceOverrideResolver } from '@happyvertical/smrt-inference/server';

registerUserInferenceResolver(
  createUserInferenceResolver({ db, fallback: createInferenceOverrideResolver({ db }) }),
);
```

**Modes.** A user or tenant may store a mode. `off` stops every call that
goes through the app's inference clients for that principal; `byo`, `local`
and `hosted` bind only a stored binding of that source and never fall back
to your app config. Modes do not govern a typed decision client the app
configured for `is()` / `evaluate()` (#3158): that route keeps running, so
leave it unconfigured where `off` must mean no model traffic. With no mode, the layers
above apply. When AI cannot run, core throws `InferenceUnavailableError`
(code `AI_UNAVAILABLE`, `reason: off | unconfigured | entitlement |
capability`) before any model call, and nothing is recorded:

- `is()` throws; it never turns "unavailable" into `false`.
- Agents end the run `skipped` with the reason, without retrying.
- Chat routes answer a structured `ai_unavailable` 503, and `AssistantDock`
  with `aiSettingsHref` shows "AI is off" with a link to your settings page.
- Your own UI asks first: `getInferenceStatus()` /
  `isInferenceAvailable()`, `createInferenceStatusHandler()` for a SvelteKit
  route, or the generated `GET {basePath}/_inference`. The answer names the
  mode and reason, never a key, endpoint or model.
- `capability` means the bound model lacks something the call requires
  (JSON mode, tools, context); see capability fallbacks in
  [core inference.md](https://github.com/happyvertical/smrt/blob/main/packages/core/agents/inference.md#capabilities-and-fallbacks-4758).

Contracts: [resolver.md](https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/resolver.md),
[settings.md](https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/settings.md),
[chat ai-unavailable.md](https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/ai-unavailable.md).

## 6. Hosted inference

Hosted inference is AI you pay for and resell: each entitled user gets a
key on your gateway (Bifrost or LiteLLM), stored as their binding with
`source: 'hosted'`.

- **Entitlement.** The paid feature key `inference.hosted`
  (`FEATURE_INFERENCE_HOSTED`, default off) is granted by a subscription
  plan. Register `createHostedInferenceEntitlementListener()` with
  smrt-subscriptions so a plan change provisions or revokes the tenant's
  users, and run the reconciler on a schedule.
- **Provisioning.** `createHostedInferenceProvisioner()` from
  `@happyvertical/smrt-inference/node`, or `smrt inference:hosted provision |
  revoke`, mints and revokes per-user gateway keys. The gateway is configured
  by `SMRT_INFERENCE_HOSTED_*`; with no provider set, hosted is off (local
  installs). Needs `@happyvertical/ai` 0.111.7 or later.
- **Key lifecycle.** A plan change updates each key's gateway budget. A
  downgrade or revoke stops SMRT using the key first, then deletes it on
  the gateway. A delete that fails is recorded as owed, and the next revoke
  or reconcile retries it. The tenant's gateway project is looked up before
  one is created, so a crash during provisioning never makes a second one.
- **Spend caps.** Plans cap hosted spend per tenant and per user with plan
  thresholds on `ai.hosted.spend_micros` and `ai.hosted.user_spend_micros`
  (integer micro-dollars). Give hosted models a cost rate: uncosted calls add
  nothing to spend.
- **Gate.** `registerHostedInferenceGate({ killSwitch, spend })` from
  `@happyvertical/smrt-inference/gate` checks every `source: hosted` call
  before it runs: kill switch, tenant, entitlement, then caps. A block throws
  `AI_UNAVAILABLE` (`reason: 'entitlement'`) and writes one `blocked` usage
  row as the audit record; `byo`, `local` and `app` calls never reach it.
- **Kill switch.** `smrt inference:hosted disable [--tenant <id>]` stops
  hosted calls on the next request, with no restart.

**Precedence.** For feature flags, a global override beats a plan grant: a
global DISABLE stops the feature for every tenant, granted or not. A tenant
override still beats both. The hosted kill switch
(`inference.hosted.enabled`) is stricter: a global DISABLE beats
everything, tenant rows included.

Contracts: [hosted.md](https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/hosted.md),
[smrt-features README](./packages/features.md),
[smrt-subscriptions AGENTS](https://github.com/happyvertical/smrt/blob/main/packages/subscriptions/AGENTS.md),
[runtime profiles](./runtime-profiles.md).

## 7. Seeing how models do

Every call writes one `_smrt_ai_usage` row: provider, model, operation,
tokens, estimated cost, duration, class and tenant, plus the prompt key, tier
requested, tier resolved, source, run id and substitutions. Prompt key, tiers
and run id are indexed columns; the rest stay in `tags`.

```bash
smrt ai:usage --by prompt,model,tier --since 7d
smrt ai:usage --by fusion          # also totals _smrt_ai_runs per fusion
smrt ai:usage --by source --tenant <id>
```

Filters choose what is totalled, never what is accounted for: calls without
a prompt key print as `(unattributed)`, calls without a cost rate are counted
as uncosted, hosted-gate blocks count as `blocked`, and other tenants' rows
are counted as excluded.

**Outcome labels.** A call cannot grade itself, so record the verdict when
you know it: `recordAiUsageOutcome(db, { usageId | runId | callId, label,
score?, evidence?, actor })`. Labels stay in the call's tenant and are never pruned
with usage rows; `smrt ai:usage` reports them per bucket.

**What is recorded.** Usage and run rows hold metadata only: never
prompts, responses or keys (content is the opt-in transcript below). The
system retention sweep prunes usage and run rows after 90 days by default
(`config({ retention })`).

**Transcripts.** An app can opt in to storing the text of calls:
`config({ inference: { transcripts: { enabled: true, sample: 0.1, maxBytes:
65536 } } })` or `SMRT_INFERENCE_TRANSCRIPTS=1`. Successful calls are
sampled (per prompt key with `transcripts.prompts: { '<key>': { sample } }`);
failed, fallen-back and degraded calls, and calls passing `transcript: true`,
are always kept, and `transcript: false` is never kept. The setting is
app-level only, with no tenant override. A host redactor
(`setTranscriptRedactor()`) runs before every write and the built-in one
always runs after it: the client's key, the object's `sensitive` field values
and known secret shapes are masked. Chat is excluded (it keeps its own
history), each row is capped at `maxBytes` with a head-and-tail cut, and
transcripts are pruned after 30 days while usage rows and labels stay for
90. Usage row, transcript and outcome share a `callId`. Reads name a tenant
and are audited: `listAiTranscripts(db, { actor, tenantId, ... })`,
`smrt ai:transcript <callId> --tenant <id>`, and `smrt ai:usage
--with-transcripts --tenant <id> [--prompt <key>]` for the worst-labelled
calls. In the [settings panel](./inference-settings.md) a platform admin
(`appEditable`) can turn transcripts on or off and set the sample rate and
byte cap, which writes the app-level row (the environment variable still
wins). The Usage tab shows how many calls have transcripts and links to
your own transcript page.

```ts
setTranscriptRedactor((messages, { part }) =>
  messages.map((m) => ({ ...m, content: scrubEmails(m.content) })),
);
const [t] = await listAiTranscripts(db, { actor: user.id, tenantId, callId });
await recordAiUsageOutcome(db, { callId, label: 'wrong', score: 0, actor: user.id });
```

**Comparing.** `smrt ai:compare --prompt <key> --a hash:<h1> --b
hash:<h2> --tenant <id>` (also `model:` and `tier:` sides) compares two
prompt versions or models on calls, cost, latency percentiles, fallback and
degraded rates, label distribution and mean score; rows matching neither
side are counted, not dropped. `--transcripts N` prints each side's N
worst-labelled transcripts side by side (an audited read). `smrt
prompts:history <key> --tenant <id>` lists the template hashes seen with
first and last seen and call counts. Both read one tenant unless
`--all-tenants`; in code, `compareAiPromptRuns(db, { promptKey, a, b,
tenantId })` and `listAiPromptTemplateHistory()`.

Contract: [core ai-usage.md](https://github.com/happyvertical/smrt/blob/main/packages/core/agents/ai-usage.md).
