# Question and learning-objective records

`QuestionAuthoringService` (SMRT #4515, extends `CourseAuthoringService`, consumed
by Hearth #68) keeps authored questions and learning objectives. Risk is high:
schema and public contract. It reuses the course authorizer: writes need
`education.course.author` (plus `generate` for generated provenance), reads that
return answer keys need `education.course.read-draft`; every call receives the
transaction executor and the operation (`create-question`, `save-question`,
`link-objectives`, `create-objective`, `save-objective`, `read-question`,
`read-worksheet`). Tenant is required; foreign ids are not-found.

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
the `worksheetVersionId` seen. It has no service writer yet: learner-side writes
need their own authority.

## Rendering

`getWorksheet` (or the pure `buildLearnerWorksheet`/`buildGuardianWorksheet`)
builds one bundle from a release lesson's pinned revisions. `worksheetVersionId` is
a digest of ordered revision ids, placement and layout params, so printable and
online renders of the same revision match and a scan can be matched later. The
learner bundle is built from an allowlist and has no key, rubric or provenance
type members; only the guardian bundle carries them. Both service audiences need
`read-draft`; learner delivery belongs to the host.

## Migration

Schema ships through normal manifest migrations: five new tables plus nullable
columns on `grades` (`question_revision_id`) and `lesson_revisions` (`questions_json`,
`layout_params_json`); test-pinned as additive. The runtime never creates tables.
