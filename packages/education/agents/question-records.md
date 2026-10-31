# Question and learning-objective records

`QuestionAuthoringService` (SMRT #4515, extends `CourseAuthoringService`, consumed
by Hearth #68) keeps authored questions and learning objectives. Risk is high:
schema and public contract. It reuses the course authorizer: writes need
`education.course.author` (plus `generate` for generated provenance), reads that
return answer keys need `education.course.read-draft`; every call receives the
transaction executor and the operation (`create-question`, `save-question`,
`link-objectives`, `create-objective`, `save-objective`, `read-question`,
`read-worksheet`, `resolve-question-revisions`, `attach-printable`). Tenant is required; foreign ids are not-found.

## Models (closed, required tenant, no REST/CLI/MCP/AI, append-only)

`Question` (identity, optional authored `courseId`), `QuestionRevision`,
`LearningObjective` (identity with tenant-unique stable `externalKey`, for
coordination with hearthed.org#35), `LearningObjectiveRevision`,
`QuestionResponse`. `save()` on an existing row and `delete()` throw. There is no
head row: the head is the highest `sequence`, and writes take an expected-head
token under a row lock and a unique `(identity, sequence)` index.

A revision holds prompt, response type, choices, subparts, media (tenant assets),
objective identity ids, concept ids, answer key, rubric and points. A missing key
or rubric is stored NULL and read back `null`; an empty key is invalid and is never
inferred. Provenance (`supplied|inferred|generated|edited|extracted`) is recorded
for each present field, defaulting to the revision's; provenance for an absent
field is refused. Objectives are linked by identity id, so wording changes, variants
and themes keep the same objective.

## Writes

`createQuestion`, `saveQuestionRevision`, `linkObjectives`,
`createLearningObjective`, `saveLearningObjectiveRevision`. Every write needs a
request key; a retry replays its original result and the same key with another
payload throws `CourseRequestKeyConflictError`. A stale head throws
`CourseStaleHeadError`; a reused objective key throws
`LearningObjectiveKeyConflictError`. Errors keep stable `code`s.

`resolveQuestionRevisions({ revisionIds })` (`read-draft`, no course; the executor and delegation fields
are passed) returns `{ items, missing }`: per found id `revisionId`, `questionId`, `sequence`,
`responseType`, `promptSummary` (plain text, whitespace collapsed, at most 200 characters) and, when
linked, `learningObjectiveKeys`. Never keys, rubrics, choices, media or provenance. 1-200 ids (else
validation error), de-duplicated, request order. An id with no revision in this tenant, foreign or
unknown alike, appears only in `missing`.

## Lessons, attempts, grades

A lesson input may carry ordered `questions` (revision id, section, column, source
page/rect anchor) and flat `layoutParams`; they are part of the lesson revision
digest, and saving requires each id to be an existing question revision of the
tenant (`QuestionReferenceError`). Newer question revisions never move a pin.

`WorkbookQuestion.questionRevisionId`/`lessonRevisionId` and the nullable
`Grade.questionRevisionId` are additive. A referenced revision must exist in the
tenant; `Grade.rubricResults` must then fit its rubric (criterion id, number or
`{points}` up to `maxPoints`; empty stays unscored; results need a rubric).
Unreferenced legacy records are unchanged. `QuestionResponse` is an append-only
learner response to one exact revision with completion mode
(`printable|online|interactive`), assistance, a correction chain, `episodeId` and
the `worksheetVersionId` seen, a numbered `attemptNumber` and the writing request's
`payloadDigest`. Writes go through `QuestionResponseService` below.

## Responses (`QuestionResponseService`)

Extends `LearnerService`, so it uses the learner authorizer, active-actor/tenant
checks and executor-bound policy reads. New authorizer actions:
`education.learner.respond` (the learner's own enrollment; a guardian never starts
an attempt) and `education.learner.review-response` (guardian only; a learner
claiming it is refused before the host is asked).

- `recordResponse`: online attempt (new episode, next `attemptNumber`) or, with
  `correctsResponseId`, the learner's correction in the same episode.
- `recordGuardianCorrection`: names the response it corrects; `response` omitted
  records assistance only and keeps the answer. Both append; nothing is rewritten.
- `readLessonResponses`: the audience follows the actor. The learner gets the
  keyless bundle (keys never leave the database call), the guardian the keyed one.

The question revision must be in the enrollment's effective lesson set
(`resolveEnrollmentLessons`, then the lesson revision's `questions`); otherwise
`QuestionResponseScopeError`. Unpinned enrollments have no authored questions.
The response is a closed shape (`text`, `numeric`, `choiceIds`, `parts`) checked
against the revision's choices and subparts (`QuestionResponseValidationError`).
Every write needs a request key (unique per learner); a replay returns the stored
row, another payload throws `CourseRequestKeyConflictError`. Other errors:
`QuestionResponseNotFoundError`, `LearnerAuthorizationError`.

## Rendering

`getWorksheet` (or the pure `buildLearnerWorksheet`/`buildGuardianWorksheet`)
builds one bundle from a release lesson's pinned revisions. `worksheetVersionId` is
a digest of ordered revision ids, placement and layout params, so printable and
online renders of the same revision match and a scan can be matched later. The
learner bundle is built from an allowlist and has no key, rubric or provenance
type members; only the guardian bundle carries them. Both service audiences need
`read-draft`; learner delivery belongs to the host.

## Generated printables (`attachGeneratedPrintable`)

Hosts render worksheets from `QuestionRevision` records but cannot write `LessonAsset`
rows. `attachGeneratedPrintable({ ...actor, lessonId, worksheetVersionId, audience })`
(`audience`: `learner` or `guardian`) renders the released lesson's worksheet to a PDF
upstream with `pdf-lib` (no host PDF dependency), stores it as a private education-owned
asset and links it to the lesson, so the durable print queue can serve it. It returns the
closed `{ lessonId, worksheetVersionId, audience, assetId, relationship, created }`; never keys,
answers or source URIs.

- `lessonId` is the materialised `lessons` row id of a released lesson (`released_lessons.lesson_id`),
  resolved in the actor's tenant; unknown and foreign ids alike are `QuestionNotFoundError`.
  `worksheetVersionId` must equal the digest of that lesson revision's refs and layout, else
  `WorksheetVersionMismatchError` (`worksheet-version-mismatch`), so a later scan matches. A lesson with no
  questions is a validation error.
- Relationship rules: the learner copy is built from the keyless learner bundle only and linked
  `printable`; the guardian copy is built from the keyed bundle (answer keys, explanations, rubric summaries)
  and linked `answer-key`. `SubmissionService.signLessonPrintable` matches only `printable` joins
  (explicit filter, test-pinned), so an answer-key copy is never signed for a learner.
- Authorization: `education.course.author` for either audience, plus `education.course.read-draft`
  for `guardian` (the audience only picks the artefact and never widens authority). A learner of the
  tenant, or a delegation naming one as actor or delegating guardian, is refused with
  `CourseAuthoringAuthorizationError` before the host authorizer is asked. Delegated agents use
  `verifyDelegation` like every authoring call (refused without it).
- Idempotent per (tenant, lesson, worksheet version, audience) via the append-only closed
  `GeneratedPrintable` model (unique index). A repeat returns the same asset with `created: false` and
  renders and stores nothing. The lesson row is locked before the check; a lost unique-index race is
  compensated and replayed once, so concurrent first calls converge on one asset with no orphan file.
- Storage: pass `printableAssets: { storage, storeOptions? }` (same shape as `SubmissionService`) to the
  service. Without it the call throws `PrintableStorageNotConfiguredError`. The PDF is a `private` asset
  (`typeSlug` `education-page`) owned by the acting guardian's profile, or for a delegated agent the delegating
  guardian's; none available is `PrintableOwnerError`. Asset rows, the join and the model row commit in one
  transaction; newly planned files are removed after rollback unless the asset row committed
  (`PrintableStorageCleanupError` carries fresh asset ids if removal fails).
- Renderer limits: standard Helvetica fonts only, Letter pages. Characters outside WinAnsi are replaced
  with `?` (never an error); media refs print as a short placeholder line, never the media. Bounded:
  200 items, 10,000 characters per text value, 400,000 in total, 150 pages (`CourseAuthoringValidationError`).
  Output is deterministic: fixed creation/modification dates, footer on every page with the worksheet
  version id and audience, PDF title/subject/keywords carrying the version id.

## Migration

Schema ships through normal manifest migrations: six new tables (`question_responses` and `generated_printables` included) plus nullable
columns on `grades` (`question_revision_id`) and `lesson_revisions` (`questions_json`,
`layout_params_json`); test-pinned as additive. The runtime never creates tables.
