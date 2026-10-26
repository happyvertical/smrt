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
- **Valid examples.** Every `data.query` request error ends with a one-line
  `Valid example: {"surfaceId":…,"request":{…}}` for that surface, in the
  failed request's mode (count, rows or facets), built from the surface id
  and caller-visible field ids with `<value>` placeholders — never the
  caller's own values.

## Failed calls are persisted (#4383)

Every tool invocation records `modelContent`, the exact (capped) text the
model was shown. `toolFailureRecord(invocation)` turns a failed, rejected or
denied call into a bounded record: `name`, `args` (over
`MAX_TOOL_FAILURE_ARGS_CHARS` = 2,000 serialized characters they become
`{ truncated: true }`; malformed-JSON calls already carry `{}`), `status`
(`rejected` | `error`), `errorKind`, a value-free `errorCode` (the error's own
stable `A-Z0-9_` code, else the kind) and `shown`.

- `runPersonaConversationTurn` authors each failed call as a `tool_result`
  row: content = `shown`, `toolCallData` `{ name, args, status, errorCode }`,
  `metadata` `{ toolStatus, errorKind, errorCode }`.
- `runAssistantTurn` does the same by default when an `author` is set;
  `author.authorFailedInvocation` overrides the row or returns `null` to
  skip it. A failed row's write error is not a dock step.
- `runToolLoop` sends each record to the `audit` sink as
  `action: 'chat.tool_call_failed'` with the record as `metadata` (a sink
  throw never fails the turn).
- Gap: a call to a tool the session does not allow-list cannot be a tool row
  — `sendAgentReply`'s authoring gate refuses the name, and that gate is
  unchanged — so it reaches the audit sink only.

## Tool errors

A thrown tool error is classified by `classifyToolError`: permission denials
and 401/403 are `not_permitted` (reported as a rejection); a `ValidationError`
or 400/404/409/422 is `invalid_request` (observation: the actionable message,
`publicMessage` first, its `code`, and a fix-and-retry hint); everything else,
including 429, is `execution_error`. An `execution_error` observation
carries the error's message, its stable `code` when it has one (e.g.
`DATA_SURFACE_QUERY_FAILED`), and the fixed `TOOL_EXECUTION_ERROR_HINT`:
the failure is the server's, so the model should not resend the same call
but answer with what it has or tell the user (#4378).
