# @happyvertical/smrt-inference

Fallback for s-m-r-t inference tiers. Bind a tier to an ordered chain of models
(an alias) and a call that hits a quota, a bad key or a renamed model moves to
the next model instead of failing. Every move is recorded on the call's usage
row, and `smrt doctor --ai` checks the bindings before you need them.

## Installation

```bash
pnpm add @happyvertical/smrt-inference
```

Import it once at startup. Importing registers it with `@happyvertical/smrt-core`.

```ts
import '@happyvertical/smrt-inference';
```

## Usage

```ts
import { config } from '@happyvertical/smrt-core';

config({
  inference: {
    aliases: {
      frontier: {
        candidates: [
          { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          { provider: 'openai', model: 'gpt-5' },
          { preset: 'lemonade', model: 'qwen3-8b' },
        ],
      },
    },
    tiers: { great: { alias: 'frontier' } },
  },
});

await article.do('Summarize this', { tier: 'great' });
```

- A failed candidate is classified as `quota`, `credential`, `missing-model`,
  `transient` (retried once), `refusal` or `missing-capability` (the call
  needs JSON or tools the model lacks), and the next one is tried.
- When all of a tier's candidates fail, the call moves down to the next
  cheaper tier. Set `inference.degrade: false` to stop that, or pass
  `minimumTier` on the call (prompts: `ai.minimumTier`).
- Text already streamed to the caller is never continued by another model.
- The usage row of the answering call carries `tierResolved` and
  `substitutions`. A call that nothing answered leaves a zero-token row with
  the reason and throws `InferenceExhaustedError`.

## Beyond fallback

- **Fusions**: bind a tier to a fusion you define (`single`, `pair` or
  `handoff` over smrt-prompts keys); callers keep asking for the tier.
- **Bindings**: users and tenants bind tiers through stored configs
  (`./resolver`) and the settings panel (`./svelte`, `./server`), tenants only
  to targets on the app's allow-list; keys stay in smrt-secrets.
- **Hosted inference**: per-user gateway keys (`./node`) and the spend gate
  and kill switch (`./gate`).
- **Sign in with ChatGPT** (`./server`, local apps): a connection service over
  the SDK's `LocalChatGPTSessionManager` and an opt-in resolver that yields a
  `chatgpt-plan` target, so a person can use their own ChatGPT plan. It is a
  preview for open source apps
  ([limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)),
  never a default and never a fallback. See
  [Inference settings](../../docs/content/inference-settings.md#sign-in-with-chatgpt-local-apps).

The app-author guide, with a worked example, is
[Inference tiers, bindings and usage](../../docs/content/inference.md).

## Checking bindings

```bash
smrt doctor --ai          # offline: providers, key variables, models, aliases, cycles
smrt doctor --ai --probe  # also asks each endpoint for its model list
```

See [AGENTS.md](./AGENTS.md) for the full contract.
