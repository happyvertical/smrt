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
  the fixed `TOOL_LOOP_ANSWER_NOW_INSTRUCTION` as a temporary `user`
  instruction. If the transcript already ends with a user turn, it is added
  to a copy of that turn's text or multimodal content instead of introducing
  consecutive user roles that strict templates reject. Otherwise it is a new
  user message. It never enters the returned `messages` transcript; input
  messages, stored conversations, and continuations stay unchanged.

## Blank answers and timeouts (#4379)

- **Retry once, within budget.** A final round with blank content and no
  usable tool calls (none made, or discarded on a no-tools round) is retried
  once without tools, with `TOOL_LOOP_ANSWER_NOW_INSTRUCTION` appended to
  that call only, and `emptyRetried: true`. The retry is skipped when the
  token budget (`maxTotalTokens`) or `deadline` is already spent: the turn
  goes straight to `empty`. The forced final call itself is one uncapped
  call, so a spent budget still gets one answer attempt; only the retry is
  budget-gated. Each blank round emits an `empty_round` step event (no model
  text; `retry` says whether a retry follows). `runAssistantTurn` does not
  show it as a dock step.
- **Report.** Still blank: `stoppedReason: 'empty'`, `content: ''`. A model
  call that throws a timeout (`AI_TIMEOUT`, `TIMEOUT`, `REQUEST_TIMEOUT`,
  `TimeoutError`, or an `AbortError` the caller's signal did not cause) ends
  `stoppedReason: 'timeout'` instead of failing or passing as an empty
  success; other errors still throw. When the final round was the forced
  no-tools call, `capReason` (`max_steps` | `budget`) keeps that cause
  alongside `empty`/`timeout`.
- **Quiet stream ends (older SDKs).** SDKs <= 0.108.0 can end a timed-out
  stream quietly: no text, no tool calls, no finish reason. That shape is a
  suspected timeout only for an AI boundary that has already reported a
  finish reason in this process (so its absence is anomalous), and only when
  the retry ends the same way; then the turn is `timeout`. A boundary that
  never reports finish reasons, or a blank reply that has one, is `empty`.
  The "has reported" flag is kept per AI client object for the process
  lifetime, so one client that routes to providers with and without finish
  reasons can mislabel an `empty` turn as `timeout` (or the reverse).
- **Timeouts are configurable, not derived.** `requestTimeoutMs` is
  forwarded as the per-call `timeout` (default: the provider's 120 s). It is
  not derived from `deadline`/`maxTurnMs`: those only stop new tool rounds
  and gate the retry.
- **Fallback text.** Both callers store `resolveTurnReply(result,
  fallback)`: the content trimmed at its outer edges only (both paths
  alike; persona replies were stored untrimmed before), or
  `emptyAnswerFallback` / `DEFAULT_EMPTY_ANSWER_FALLBACK` when blank.
  `runPersonaConversationTurn` returns it as `reply` (plus `replyFallback`);
  voice and the chat stream use it. `runAssistantTurn` replaces its old
  `'Done.'`. The plain chat-stream path retries a blank stream once, then
  sends the fallback, or `CHAT_STREAM_TIMEOUT_ERROR` only under the
  quiet-end rule above.
- **Stored metadata.** Every authored assistant reply carries
  `replyMetadataFor(result, reply)`: `metadata.stoppedReason` (enum),
  `metadata.capReason` when set, and `metadata.fallback` (`empty` |
  `timeout`) when the content is the fallback. Hosts read the stop reason
  from `turn.result.stoppedReason` (persona), `AssistantTurnResult` / the
  `done` event's `stoppedReason` and `capReason` (assistant), or the stored
  message's metadata. `isFallbackReply(message)` tells a fallback apart; the
  assistant route's and voice's history builders skip fallback replies so
  they are never replayed to the model as answers. The chat-stream paths
  (plain and persona) take history from the browser, which sends no
  metadata, so they recognise an assistant message whose text exactly
  equals the configured or default fallback text. All three replay the
  fixed `FALLBACK_HISTORY_PLACEHOLDER` in its place rather than dropping
  it: a drop would leave two user messages in a row, which strict chat
  templates (Gemma, Anthropic) reject. Hosts should hide feedback
  controls (thumbs, corrections) on a message where `isFallbackReply` is
  true: there is no model answer to rate.
- **Dock.** The `done` event's `capReason` reaches the dock, which offers
  Continue for a capped turn even when it ended `empty` or `timeout`.
- **Reasoning.** `AIResponse.reasoning` (newer SDKs, sdk#1459) is read
  defensively, capped at `MAX_TOOL_LOOP_REASONING_CHARS` code points, passed
  to `onReasoning` (forwarded by both callers; a throw is ignored) and
  returned as `result.reasoning` (the retry's, else the first round's).
  Reasoning can quote documents and tool results: send it only to logs with
  the same protection as the conversation. It is never persisted and never
  the answer unless the host opts in with `answerFromReasoning` — which
  stores raw chain-of-thought as the reply (`contentFromReasoning: true`).
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
  caller's own values. Row examples cap page size at the surface’s
  `maxPageLimit`.

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
