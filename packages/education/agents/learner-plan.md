# Enrollment Plan reads

`LearnerPlanService(db, authorizeLearner, authorizeCatalog)` extends the existing
LearnerService transaction/active actor boundary and adds private parent notes
([notes contract](enrollment-notes.md)). Its `withTransaction` and `withExecutor`
services retain the Plan methods. Root exports `EnrollmentPlanView` and
`PlanLessonView`; all results are data only.

`listPlan(request)` returns exact learner enrollments ordered by sortOrder/id.
`getEnrollmentPlan({...request,enrollmentId})` verifies that exact tenant,
learner, enrollment and curriculum before reading its course. Missing or denied
course visibility returns `availability: 'unavailable'`, `course: null`, and
empty lessons/evidence; it does not interrupt other authorized enrollments.
Actor/enrollment denial still rejects the request. Operational database errors
are not disguised as missing material.

The course DTO contains only id, title, subject, summary, modality and sourceKey.
Technical unfiled capture scaffolding has sourceKey exactly `unfiled-work`;
consumers exclude it by identity, never by title. The DTO does not invent a cover
or claim any source/asset preview binding. It returns no teacher or answer-key
assets. Lessons preserve catalog section/lesson order and existing role-filtered
progress, including private workbook feedback rules. Optional workbookActivityId
is resolved for the exact tenant/learner/enrollment/lesson; consumers route that
work to their workbook interface, not generic scan capture.

Workbook progress uses the same explicit parent completion projection as Work.
Old grade-derived complete/skipped rows without a current decision project in
progress with completedAt null; they cannot contribute a completion timestamp to
progressEvidence. Later analysis of the same attempt retains a parent's decision;
a new correction or practice attempt reopens it. Ordinary lesson progress is
unchanged. See [the workbook contract](workbook-service.md).

For required-online lessons, optional sourceUrl comes only from the same
catalog-authorized Lesson.externalUrl and must be HTTPS without credentials.
Answer URLs and asset locations are never projected. A missing or unsafe online
URL is unavailable to Continue and cannot block a later usable lesson. Consumers
revalidate links at their own browser boundary and display honest unavailable
material states.

`nextActionableLessonId` considers planned/active enrollments and only unstarted
or in-progress lessons with usable material. Planned is usable because normal
`enroll` creates planned enrollments and the base workflow has no activation API.
Paused/completed/dropped enrollments have no next action. Complete/skipped lessons
and submitted/needs_review work never instruct rework. `awaitingReviewLessonIds`
is separate from Continue. Reads never change progress or create learning history.

`progressEvidence` is nullable `{kind: 'started'|'completed',at,lessonId}` from
visible durable progress start/completion timestamps. It is the newest such
recorded timestamp, **not** latest actual work. Repeated starts preserve the
original startedAt. Display it as “Last recorded start/completion”, never infer
activity from updatedAt, enrollment ordering, notes, or missing timestamps.

```ts
import { LearnerPlanService, ENROLLMENT_NOTE_MAX_LENGTH, validateEnrollmentNote }
  from '@happyvertical/smrt-education';
const service = new LearnerPlanService(db, authorizeLearner, authorizeCatalog);
const plan = await service.listPlan(serverLearnerRequest);
validateEnrollmentNote(text, requestKey); // input validation, not authorization
const note = await service.addEnrollmentNote({
  ...serverGuardianRequest, enrollmentId, text, requestKey,
});
```

Build before consuming the public package; deploy its ordinary additive manifest
migration before using notes. No runtime handler creates application schema.
Shared Plan and note workflows run against SQLite and PostgreSQL.
