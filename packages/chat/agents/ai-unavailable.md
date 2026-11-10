# AI unavailable answers (#4757)

When core throws `InferenceUnavailableError` (`AI_UNAVAILABLE`: the
principal's mode is `off`, nothing is configured, ...; see
[core inference.md](../../core/agents/inference.md#inference-mode-and-ai_unavailable-4757)),
chat answers a structured message instead of a 500. Source:
`src/ai-unavailable.ts` (server), `src/client.ts` (browser parsing).

## Wire shape

`503` with `{ type: 'unavailable', code: 'ai_unavailable', error, unavailable }`:
`error` is a user-safe sentence for the reason, `unavailable` is core's
`InferenceStatus` (`available: false`, `mode`, `reason`, `tier?`). No stack,
no provider detail, never a key. `chatUnavailableBody(error)` builds it from
the typed error (matched by code, so another core copy's error counts);
`chatUnconfiguredBody()` is the `unconfigured` body.

- `mountAssistantRoutes()`: the AI factory's `AI_UNAVAILABLE`, and the default
  factory's `AIProviderNotConfiguredError` (as `unconfigured`), answer this
  instead of `assistant_unavailable`, before anything is stored. The
  not-configured error still reaches `onError` (it names the config to
  add); a chosen mode `off` is not logged.
- `createChatStreamHandler()`: `authorize` throwing it answers the 503; a
  mid-turn one is the in-band `error` event with `code: 'ai_unavailable'`
  and `unavailable`.
- Dev routes: `/api/dev-chat` and `/api/dev-character-conversation` answer
  the 503; `/api/dev-chat-stream` lets it reach the handler. Unconfigured dev
  routes keep their local fallback (dev-chat, dev-chat-stream).

## Browser

`./client`: `SmrtChatBackend` raises `ChatUnavailableError` (`unavailable`
status) for both shapes; `readChatUnavailableStatus(body)` parses one
(dependency-free, mirrors core's status type). The dock's HTTP transport sets
`AssistantHttpError.unavailable`. `AssistantDock`'s `aiSettingsHref` renders
`AiUnavailableNotice` ("AI is off" plus an "Open AI settings" link to the
host's page) in place of the error banner until a send succeeds; hosts render
the notice on their own surfaces from `./svelte`.

Tests: `src/ai-unavailable.test.ts`, `src/sveltekit-defaults.test.ts`,
`src/svelte/components/shared/__tests__/AiUnavailableNotice.test.ts`,
`src/svelte/components/assistant/__tests__/assistant-dock-ai-unavailable.test.ts`.
