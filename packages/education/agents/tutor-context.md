# Tutor context and sessions

No AI call, prompt text or provider lives here. The host builds prompts from
`TutorContext` and owns the model call and spend ceiling; this package records
what was said.

## TutorContextService.compose

`compose({ ...LearnerRequest, audience: 'learner' | 'guardian', enrollmentId?,
lessonId?, questionRevisionId? })` extends `QuestionResponseService`; every read uses
the service executor (the transaction's inside `withTransaction`). The host
authorizer is asked `education.tutor.read` with `own` and `relationshipTypeId`
as for `LearnerService`. A lesson needs its enrollment and must be in the
enrollment's effective set; a focus question must belong to that lesson
(otherwise `LearnerAuthorizationError`). The guardian audience is refused for
the learner's own actor whatever the host answers.

Result: learner (name, level, `interestTheme`: the learner-safe label and key or
null, read-only; never the free `settings`), enrollment (status, pace; no notes), course,
section and lesson titles, learner-facing lesson body (withheld for
personal-use-copy), objectives, own progress status, the learner-visible
question rendering (prompt, response type, choices, subpart prompts, points; no
media or anchors), submission count with latest status only, and the newest
**released** feedback text (guardian: newest guardian-confirmed revision), plus
`answerKeyAvailable`, `truncated` and `contextHash`.

Learner audience never carries answer keys, rubrics, key assets or their ids,
storage URIs, enrollment parent notes, grades, other learners or grading
internals: it is built from an allowlist and keys are read only to set the
boolean. The guardian audience adds capped answer-key and rubric text, still no
storage locators or notes. Do not add fields without a sentinel test in
`tutor-context.test.ts`.

Bounds (exported constants): body 8000, prompt/choice/subpart 2000, key 2000,
feedback 2000, titles 300, 30 questions (the focus question is kept), 12 choices
and subparts, 10 objectives, 48000 serialized characters overall (trailing
questions drop first). Any cut sets `truncated`.

## TutorSessionService

Append-only `TutorSession`, `TutorSessionClosure` and `TutorExchange` (new
tables `tutor_sessions`, `tutor_session_closures`, `tutor_exchanges`;
tenant-scoped, closed generated surfaces, update/delete rejected). A session is
open until its single closure row exists. Sessions store ids, audience, mode,
actor, voice consent and the context digest, never context text.

- `open` (`education.tutor.exchange`): `requestKey` idempotent per learner; a
  replay with a changed payload is `TutorRequestKeyConflictError`. Voice needs
  `voiceConsent: true` the host recorded (`TutorConsentRequiredError`). Guardian
  audience is refused for the learner's own actor.
- `append` (`education.tutor.exchange`): role `learner|tutor|system`; `learner`
  only from the learner themself. Text 1 to 4000 characters else
  `TutorExchangeError`. Idempotent per session `requestKey`; sequence is
  server-assigned from 1; closed session is `TutorSessionClosedError`. Optional
  `marker` (`none|filtered|redacted|flagged`), `toolSummary`, token counts.
- `close`: appends the closure; closing twice returns `changed: false`.
- `listForLearner` (`education.tutor.read`): sessions newest first, `limit`
  (<=50) and `cursor`, per-session exchanges bounded by `exchangeLimit` (<=200)
  with `exchangesTruncated`; `sessionId` + `afterSequence` page one transcript.
  A guardian reads through the host's decision on the relationship.

Missing tables raise `LearnerHistoryUnavailableError`. Concurrent appends rely on
the unique `(tenant, session, sequence)` index.
