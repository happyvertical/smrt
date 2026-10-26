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

## Blank answers and timeouts (#4379)

- **Retry once.** A final round with blank content and no usable tool calls
  (none made, or discarded on a no-tools round) is retried once without
  tools, with `TOOL_LOOP_ANSWER_NOW_INSTRUCTION` appended to that call only.
  `emptyRetried: true` marks it, and an `empty_round` step event (no model
  text) is emitted for each blank round. `runAssistantTurn` does not show it
  as a dock step.
- **Report.** Still blank after the retry: `stoppedReason: 'empty'`,
  `content: ''`. A model call that throws a timeout (`AI_TIMEOUT`, `TIMEOUT`,
  `REQUEST_TIMEOUT`, `TimeoutError`, or an `AbortError` the caller's signal
  did not cause) ends `stoppedReason: 'timeout'` instead of failing or
  passing as an empty success; other errors still throw. Older SDKs
  (<= 0.108.0) end a timed-out stream quietly, so a streamed round with no
  text, no tool calls and no `finishReason`, followed by a retry of the same
  shape, is also `timeout`.
- **Timeouts are configurable, not derived.** `requestTimeoutMs` is
  forwarded as the per-call `timeout` (default: the provider's 120 s). It is
  not derived from `deadline`/`maxTurnMs`: those only stop new tool rounds,
  and cutting the final answer at the deadline would turn a late answer into
  none.
- **Fallback text.** Callers store `replyContentFor(result, fallback)`: the
  content when non-blank (unchanged), else `emptyAnswerFallback` or
  `DEFAULT_EMPTY_ANSWER_FALLBACK`. `runPersonaConversationTurn` authors it
  and returns it as `reply` (voice and the chat stream use it);
  `runAssistantTurn` replaces its old `'Done.'`; the plain chat-stream path
  retries a blank stream once, then sends the fallback, or
  `CHAT_STREAM_TIMEOUT_ERROR` after two quiet ends. Nothing else that is
  stored or audited changes.
- **Reasoning.** `AIResponse.reasoning` (newer SDKs, sdk#1459) is read
  defensively, capped at `MAX_TOOL_LOOP_REASONING_CHARS`, passed to
  `onReasoning` and returned as `result.reasoning` for host logging. By
  design it is never persisted and never the answer unless the host opts in
  with `answerFromReasoning` (then `contentFromReasoning: true`): reasoning
  is unreviewed model scratch work, not a reply.
- **Budgets on the persona path.** `runPersonaConversationTurn` forwards
  `maxTotalTokens`, `deadline`, `toolChoice` and `requestTimeoutMs`
  (`runAssistantTurn` exposes them as `maxTurnTokens`/`maxTurnMs`).

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
- **`surfaceId` placement** (`data.query`, `data.inspect`). A
  `request.surfaceId` string is lifted to the top level and removed from
  `request`; a `query` object standing in for `request`, or one that is
  `request`'s only key, is unwrapped (its keys are then validated as usual,
  so nothing is dropped; unwrapping was chosen over rejecting because the
  intent is unambiguous). Two different ids are
  `DATA_QUERY_SURFACE_ID_CONFLICT`; no id at all is a 400
  `DATA_QUERY_SURFACE_ID_REQUIRED` with an example. Only an id naming no
  visible surface gets the generic "not available" denial. A filter `kind`
  that is an operator (`in`) or a logical word (`or`) gets a targeted hint.
- **Valid examples.** Every `data.query` request error ends with a one-line
  `Valid example: {"surfaceId":…,"request":{…}}` for that surface, in the
  failed request's mode (count, rows or facets), built from the surface id
  and caller-visible field ids with `<value>` placeholders — never the
  caller's own values.

## Dedupe of identical read-only calls (#4382)

Within one `runToolLoop` call, a server call that repeats an earlier one —
same tool, same arguments after canonicalization (object keys sorted) — is
not executed again. Its invocation has `deduped: true`, mirrors the earlier
`ok`/`error`, and observes the fixed `TOOL_CALL_DEDUPED_NOTE` instead of a
second copy of the result.

- Only read-only, idempotent tools qualify: manifest `read`, and
  `data.discover`, `data.inspect`, `data.query`. Mutating tools,
  `agents.invoke`, other extra tools and browser tools never do; nor do
  malformed-argument calls.
- **Invalidation.** Any resolved server call that is not on that allow-list
  (a write, `agents.invoke`, any other extra tool), whatever its result,
  clears every remembered read, so a read after a write always runs fresh.
- A repeat of a rejected or refused call observes
  `TOOL_CALL_DEDUPED_REJECTED_NOTE` (repeating it will not work; fix the
  arguments) instead of the plain pointer note.
- An earlier `execution_error` is not reused: a transient server failure
  may be retried. Arguments over 4,000 canonical characters are never keyed.
- The cache holds at most `MAX_DEDUPED_CALLS_PER_TURN` (64) calls and lives
  only inside that `runToolLoop` call: never across turns (an assistant
  resume leg starts a fresh cache).
- Deduped calls count toward the step cap: a round of repeats is still a
  round, so a model stuck repeating a call still stops at `maxSteps`.
- The audit sink gets `action: 'chat.tool_call_deduped'` (not a fresh
  execution or failure); the persona path's tool row carries
  `toolCallData.deduped: true`.

## Failed calls are persisted (#4383)

Every tool invocation records `modelContent`, the exact (capped) text the
model was shown. `toolFailureRecord(invocation)` turns a failed, rejected or
denied call into a bounded record: `name`, `args` (over
`MAX_TOOL_FAILURE_ARGS_CHARS` = 2,000 serialized characters they become
`{ truncated: true }`; unserializable ones `{ unserializable: true }`;
malformed-JSON calls carry `{}`), `status` (`rejected` | `error`),
`errorKind`, `errorCode` (the error's own stable `A-Z0-9_` code, else the
kind) and `shown`. Like a successful call's row it carries the arguments
and shown text, so it is not value-free. A deduped repeat has no record.

- `runPersonaConversationTurn` authors each failed call as a `tool_result`
  row: content = `shown`, `toolCallData` `{ name, args, status, errorCode }`,
  `metadata` `{ toolStatus, errorKind, errorCode }`.
- `runAssistantTurn` now does the same **by default** when an `author` is
  set — a behaviour change: before, failed calls were never persisted.
  `author.authorFailedInvocation` overrides the row or returns `null` to
  skip it; `authorInvocation` sees successful calls only (never a failed or
  deduped-failed one). A failed row's write error is not a dock step.
- `runToolLoop` sends the audit sink `action: 'chat.tool_call_failed'` with
  only `toolFailureAuditMetadata(record)`: `name`, `status`, `errorKind`,
  `errorCode`, `argsChars`, `shownChars` — never the arguments or the shown
  text, which can hold user data or raw server errors. A sink throw never
  fails the turn.
- A browser tool call with malformed arguments is recorded the same way (an
  invocation, an audit entry, `onInvocation`), besides being answered in
  the transcript.
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
