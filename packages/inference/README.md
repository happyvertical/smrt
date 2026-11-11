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

## Assistant engines (Node hosts)

Import these adapters from `@happyvertical/smrt-inference/server`. The host
supplies authenticated persistence, tool policy, owner approvals and UI events.
There is no dependency on smrt-chat or app-shell. The full
[host contracts and security rules](agents/engines.md) describe each callback.

For a chat-style tool loop, use the person's explicit ChatGPT connection:

```ts
import { createChatGPTModel } from '@happyvertical/smrt-inference/server';

const model = await createChatGPTModel({
  connection, // createChatGPTPlanConnection, after explicit engine selection
  toolNamespace: { name: 'app_tools', description: 'Tools for your own app' },
  settingsHref: '/settings/ai',
});
const reply = await model.complete({
  messages, tools, maxTokens: 2048, signal,
  onText: delta => send({ type: 'text', delta }),
});
// Host executes reply.toolCalls through its policy/approval gate, persists
// results and replays reply.raw on the next round. Bound the loop in the host.
```

The model uses only `chat()` and `onProgress`; `maxTokens` stays in the host.
There is no API-key fallback. Known failures are `EngineModelFailure`; treat
other errors generically and never expose provider messages or causes.

For either local CLI engine, let its subprocess own the turn:

```ts
import {
  createAgentCliService, locateCli, runAgentTurn, tokenCredentials,
} from '@happyvertical/smrt-inference/server';

const cli = createAgentCliService(); // one per host, not per status request
const tool = 'claude-code'; // or 'codex': same host contract
await runAgentTurn({
  tool, text, signal, emit: send,
  mcpUrl: 'http://127.0.0.1:4801/mcp', // host endpoint enforces owner/tool policy
  deps: {
    locate: selected => locateCli(selected, cli.agentCliDeps()),
    stateDir: async () => privateAgentDirectory,
    credentials: tokenCredentials(localTokenStore, {
      holder: conversationHolder, label: 'App assistant', scopes: ['assistant.use'],
    }),
  },
  host: {
    appendMessage, lastSession,
    guidance: async () => ({ systemPrompt: guidance, prompt: text }),
    allowTool: name => offeredTools.has(name),
    approvals: { subscribe: subscribeTurnApprovals, get: getOwnerApproval },
    describeResult: async ({ text }) => ({ summary: summarize(text) }),
  },
});
```

The host verifies the owner before minting a token. The CLI receives it only in
its environment, with provider keys stripped, built-in tools disabled, a
loopback-only MCP URL and a private working directory. Stop/timeout kills its
process tree. Status and sign-in use the CLI's own commands; no credential
stores are read. **Do not offer in-app Claude subscription login**: use the
person's own Claude Code and its vendor login. ChatGPT sign-in remains a
separate opt-in preview under the limitations linked above.

`inferenceEngineStatus(engine, { cliStatus, chatgpt, apiStatus, actions })`
composes installed/signed-in/configured diagnostics; API-key resolution and
settings destinations come from the host. The saved API-key engine continues
through the normal inference resolver and SDK, independently of these adapters.

## Checking bindings

```bash
smrt doctor --ai          # offline: providers, key variables, models, aliases, cycles
smrt doctor --ai --probe  # also asks each endpoint for its model list
```

See [AGENTS.md](./AGENTS.md) for the full contract.
