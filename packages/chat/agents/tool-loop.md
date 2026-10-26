# Tool loop termination and tool-call hygiene

`runToolLoop()` (`src/tool-loop.ts`) runs one bounded
`tool_call → observe → respond` turn. Both `runPersonaConversationTurn()` and
`runAssistantTurn()` go through it, so every rule below holds for both.

## Termination

- Rounds that execute tools are capped by `maxSteps`
  (`DEFAULT_MAX_STEPS = 8`; `initialSteps` counts earlier legs of a resumed
  turn). `maxTotalTokens` (with `initialTokens`) and `deadline` end the turn
  early with `stoppedReason: 'budget'`.
- **Forced final call (#4378).** At the cap, or once the budget is spent, the
  next round is offered no tools (`tools: undefined`, `toolChoice: 'none'`),
  and any tool calls the model still emits are discarded. That call alone gets
  the fixed `TOOL_LOOP_ANSWER_NOW_INSTRUCTION` appended as a `user` message
  (every chat template accepts a mid-conversation `user` turn). It is sent on
  that call only and never enters the returned `messages` transcript, so
  stored conversations and continuations are unchanged.

## Observation bounds

- A server tool observation is serialized and capped at
  `MAX_SERVER_TOOL_OBSERVATION_CHARS` (16,000, the same bound as
  `MAX_CLIENT_TOOL_RESULT_CHARS` for browser results) before it enters the
  transcript (#4378). A longer one is cut and gets the fixed
  `SERVER_TOOL_OBSERVATION_TRUNCATED_MARKER`, which says the result is
  incomplete and tells the model to narrow the request (filter, fewer fields,
  a smaller page, or a count). The marker carries no tool output.
- The cut never splits a surrogate pair (it keeps one unit fewer instead);
  browser results (`appendClientToolResults`) are cut the same way.
- Only the model's copy is capped: `ToolInvocation.observation` (handed to
  `onInvocation`, persisted as tool messages, audited) keeps the full value.
- A tool returning `undefined` observes `null`; an unserializable result
  observes `{"error":"unserializable_result"}` instead of throwing.

## Argument hygiene (#4378)

Arguments the model sends are never dropped silently; each case below is an
`invalid_request` observation the model can correct and retry. Messages are
value-free: they name the accepted shape, never the model's values.

- **Malformed JSON.** Raw arguments that do not parse to a JSON object
  (malformed JSON, an array, a scalar) fail with code
  `TOOL_ARGUMENTS_MALFORMED`; the tool does not run and the invocation's
  `args` is `{}`. Blank or `null` arguments are a no-argument call. A browser
  tool call with malformed arguments is answered in the transcript and never
  suspends the turn.
- **Manifest `read`.** Accepts only `id` (string), `where` (object of
  equality filters), `limit` (integer >= 1) and `offset` (integer >= 0). This
  is stricter than before, where these were dropped or defaulted silently:
  an unknown key such as `filter`, a numeric `id`, a non-object `where`, and
  a fractional, zero or string `limit` (or a negative or fractional `offset`)
  now fail with a retryable `invalid_request` (`TOOL_ARGUMENTS_INVALID`)
  instead of listing every row. The offered schema says
  `additionalProperties: false` with `integer` `limit`/`offset` minimums.
- **`data.query`** (`@happyvertical/smrt-agents`). With a `request` object,
  the only other top-level key allowed is `surfaceId`; a sibling such as
  `filter` fails with `DataSurfaceRequestError` reason
  `DATA_QUERY_ARGUMENTS_UNEXPECTED`, naming only misplaced grammar keys. The
  flat form (request keys beside `surfaceId`, no `request`) still works.

## Tool errors

A thrown tool error is classified by `classifyToolError`: permission denials
and 401/403 are `not_permitted` (reported as a rejection); a `ValidationError`
or 400/404/409/422 is `invalid_request` (observation: the actionable message,
`publicMessage` first, its `code`, and a fix-and-retry hint); everything else,
including 429, is `execution_error`.
