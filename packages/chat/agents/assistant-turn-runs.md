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
with the user-facing error `ai_tracking_disabled` before any call is sent. An
external `turnDriver` makes no model call here and opens no run.

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
closes the `handoff` with how the child ended. An external `turnDriver` opens
no run here, so an external-engine step records no calls. Tests:
`turn-tracking-child.test.ts`.
