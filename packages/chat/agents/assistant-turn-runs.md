# Assistant turns as AI runs (#5005)

`mountAssistantRoutes` builds a tracked client per turn
(`createTrackedAiClient`, the principal's tenant on the request's database,
over the turn's client, `transcript: false` because chat stores the
conversation) and passes `tracking` to `runAssistantTurn`
(`turn-tracking.ts`). The turn then opens one `turn` run before its first
model call (`AssistantTurnRun.open`, definition `chat.assistant.turn`), the
tool loop calls the tracked client (each model call is a reserved, settled
call of the run: one usage row and one `call` event, tagged with the prompt
key), tool use is an `action` event and its result an `observation` event
whose `parent_event_id` is the action, and the run ends `done` (`cancelled`
for an abort, `failed` for an error). Messages are never copied into the
trajectory: events point at them with `payload_ref` (`chat-message:<id>`).
A turn that needs an owner approval records a requested `approval` event
(`payload_ref` `approval:<id>`) and ends `done` with the approval pending; it
does not wait. The decision is recorded as an `approval` event in the NEXT
turn's run, once, with `parent_event_id` the request in the earlier run
(`tracking.decisions` reads the thread's decided approvals from the host's
store). A chat turn does not run untracked: with usage persistence off it ends
with the user-facing error `ai_tracking_disabled` before any call is sent.
A ChatGPT plan turn is a built-in loop over a host-built client: its calls
are recorded under the engine (`label` on `createTrackedAiClient`, provider
`chatgpt`, the bound model unless the response reports one), uncosted, with
`tier_requested`/`tier_resolved` from the prompt and the selection.

## A turn on an external engine (Claude Code, Codex)

An external `turnDriver` turn opens the same run. The engine's turn is ONE
tracked call of it (`AssistantTurnRun.beginEngineCall`, reserved in
`runExternalAssistantAttempt` before `driver.run`, call id minted first):
the engine runs its own loop and reports one result per turn, so its internal
model calls are not seen one by one. The usage row's provider is the engine
id, its model the one the CLI reported (Claude Code does; Codex does not),
else the tier binding's; it carries the prompt key and tiers and is always
uncosted. Tokens are the CLI's reported usage (`EngineExecution.tokens`,
split into `inputTokens`/`outputTokens`, cache reads and writes in the
input); a turn that answered without them is charged what it reserved (ai-runs
section 6.4) and its row has NULL token columns. A refused reservation
(`maxCalls`, `maxTokens`, `maxDurationMs`, or a parent's limit or stop) ends
the turn `budget` before the CLI starts; `callTimeoutMs` aborts the CLI and
fails the turn. A turn that fails, is cancelled or hands off to a workflow is
settled with its tokens when the CLI reported them, else released. Limits:
`maxSteps` cannot bound the CLI's internal rounds (a workflow parent's step
limit still refuses the child's call), and a parent stop or cancel during an
engine turn takes effect at its end, not by interrupting the CLI. Tests:
`sveltekit.test.ts` (external engine), `engines.test.ts` (real driver over
the stub CLI), `turn-tracking-child.test.ts`.

The system prompt is the registered prompt `chat.assistant.system`
(`chatAssistantSystemPrompt`): the host's `systemPrompt` option is its runtime
layer and an app or tenant override of the key replaces it
(`resolveChatAssistantPrompt`). The text is sent only when a layer above the
default supplies it, so a host with no `systemPrompt` sends no system message,
as before. The prompt declares the tier the assistant asks for, `ai.profile: 'best'`;
`resolveChatAssistantTier({ db, tenantId })` reads it back through
`resolvePrompt` (so config and stored layers apply) and a host binds the
turn's model at that tier.

## A workflow step's turn (child run)

A host's trusted `internalTurn` may return `step: { parent, prompt,
stepIndex, name }` (the template-sveltekit host does, for each workflow step
it runs through the assistant route). The turn's run is then a CHILD of the
workflow run (`parent_run_id`, opened with a `handoff` event in the parent
named after the step, in the same transaction); its calls carry the parent's
claim fence and are tracked under the step's registered `prompt` (whose text
follows the host's system prompt), so they roll into the parent's inclusive
totals and budget. A parent stop or limit stops the child's next call, and
when the turn ends a stopped or cancelled child stops the parent the same way
(`stopAiRunForChild`); cancelling the parent cancels the child. The turn
closes the `handoff` with how the child ended. A step on an external engine
is the same child run with its one engine call. Tests:
`turn-tracking-child.test.ts`.
