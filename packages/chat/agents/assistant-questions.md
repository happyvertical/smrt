# Structured assistant questions (#4100)

Part of the [smrt-chat guidance](../AGENTS.md).

An assistant turn that asks the person to choose is data, not prose. A
transport attaches an `{ kind: 'assistant-question', id, prompt, fields }`
object to an assistant message's `toolCallData` (alone or in an array). Fields
are choice fields: `options` (`value`, `label`, `hint?`, `keywords?`),
`multiple?`, `default?`, `required?`. `assistant-question.ts` validates it
(`parseAssistantQuestion`, `assistantQuestionFromMessage`), seeds defaults,
validates answers and describes them in one line.

`AssistantDock` renders it as `AssistantQuestionForm`: one fieldset whose
legend is the prompt; a single choice is a smrt-ui radio group (a select past
six options), several choices are checkboxes; the default is preselected and
focus moves into the newest form. Once answered it is a read-only summary.

Submitting calls the optional `AssistantTransport.answerQuestion({ threadId,
messageId, questionId, values, clientRequestId })`, so the transport continues
the turn in code with no model round-trip, and the dock merges its result like
a send. A transport without it gets the answer as an ordinary message
(`describeAssistantQuestionAnswer`, "Group by: Status"). A typed reply still
works: `matchAssistantQuestionText` resolves free text against the options
(shared words with label, value, hint and keywords; earlier option on a tie).

Options always come from code that knows the domain (a report source's
dimensions, for example), never from a model's free text. The planner's
runtime-report follow-ups are the first user.
