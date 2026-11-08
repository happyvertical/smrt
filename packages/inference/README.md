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
  `transient` (retried once) or `refusal`, and the next one is tried.
- When all of a tier's candidates fail, the call moves down to the next
  cheaper tier. Set `inference.degrade: false` to stop that, or pass
  `minimumTier` on the call (prompts: `ai.minimumTier`).
- Text already streamed to the caller is never continued by another model.
- The usage row of the answering call carries `tierResolved` and
  `substitutions`. A call that nothing answered leaves a zero-token row with
  the reason and throws `InferenceExhaustedError`.

## Checking bindings

```bash
smrt doctor --ai          # offline: providers, key variables, models, aliases, cycles
smrt doctor --ai --probe  # also asks each endpoint for its model list
```

See [AGENTS.md](./AGENTS.md) for the full contract.
