# RFC: `@happyvertical/smrt-education`

Tracking issue: [#3964](https://github.com/happyvertical/smrt/issues/3964).
Status: draft for discussion.

## Problem

We want a learning platform whose first users are homeschool families in one
co-op group, and whose second users are people taking training courses for
HappyVertical software. Both need the same things: a catalog of courses pulled
from wherever they exist (Khan Academy, CrunchLabs, PDFs, our own material), a
per-learner plan, evidence that work was done (including paper work that is
printed, completed, and photographed), grading, mastery tracking, suggestions
for what to do next, rewards, discussion, and an interactive tutor.

The package must stay domain-neutral. "Homeschool" is an application built on
it, not a concept inside it. Nothing in the models should say "kid", "parent",
"grade 4", or "co-op"; those are roles, attributes, and tenant shapes the
application supplies.

## What smrt already provides

The platform needs far fewer new primitives than the feature list suggests.
The reuse map below is the main design decision; everything in the next
section is what is left after it.

| Need | Existing package | How it is used |
|---|---|---|
| Group → family tenants | `smrt-users` Tenant hierarchy, `smrt-tenancy` | The co-op is a tenant; each family is a child tenant. Catalog rows are global (null tenant), group-shared, or family-private, resolved `findWithGlobals`-style like tags and facts. |
| Adults sign in, kids do not | `smrt-users` Membership, `DeviceCredentialService` | A guardian has a Membership in the family tenant and the group tenant. A learner is a Person profile with an optional User; a shared family device uses a per-person PIN session. |
| People and family relationships | `smrt-profiles` Person, `ProfileRelationship` | Learner and guardian are Profiles; guardianship is a relationship, not a field. |
| Worksheets, scans, photos, videos | `smrt-assets` AssetRuntime, `@happyvertical/ocr`, `@happyvertical/pdf` | Printable lessons own a PDF asset. Scans are assets on a submission. OCR and PDF rendering run as background jobs. |
| Discussion group, messaging | `smrt-chat` rooms and threads, `smrt-comments`, `smrt-messages` | Group rooms live in the group tenant. Comments attach to courses and lessons (reviews, suggestions). Messages deliver notifications and direct mail. |
| Interactive tutor | `smrt-chat` agent sessions, `smrt-personas`, `smrt-agents`, `smrt-voice`, `smrt-avatar-starter` | One `AgentPersona` per learner, context-scoped to the Learner record, customised by learner or guardian. The education package contributes the tutor's tools and guardrails, not the chat stack. |
| Points and rewards | `smrt-ledgers` | Points are an integer ledger account per learner. Badges, rewards, and redemptions are the only new rows. |
| Background work | `smrt-jobs` | OCR, extraction, mastery recalculation, suggestion refresh, reminders. |
| Catalog import | `smrt-ingestion` | External sources become ingestion sources with review-before-apply; v1 can bypass it with manual entry. |
| Certificates for training courses | `smrt-human-resources` `Qualification` | A completed training course can issue a `HeldQualification`. Not needed for v1. |
| Enjoyment and interest signals | `smrt-personas` learning loop pattern | The feedback → confidence → reflection shape is reused for learner attributes, but on education's own rows. |

## New primitives

Package `@happyvertical/smrt-education`, directory `packages/education`. All
models are `@smrt()` objects. Tenancy is optional on catalog models (shared
rows) and required on learner models.

### Catalog: what can be learned

**Course** (STI base). The unit a learner enrols in. Not called "curriculum"
because that word names the learner's plan below.

- `title`, `slug`, `summary`, `description` (markdown)
- `sourceKey` (`manual`, `khan-academy`, `crunchlabs`, ...), `sourceUrl`,
  `sourceRef` (the source's own id), `license`
- `subject` (tag slug), `tags`
- `levelMin`, `levelMax`: integer level band. The application maps levels to
  grade names; the package does not know what a grade is.
- `difficulty = 0.0` (decimal 0–1), `estimatedMinutes = 0`
- `modality`: `online`, `printable`, `kit`, `video`, `game`, `mixed`
- `status`: `draft`, `published`, `archived`
- STI subclasses only where behaviour differs: `ExternalCourse` (completion is
  attested or reported, content lives elsewhere), `AuthoredCourse` (content is
  our lessons). A CrunchLabs box is an `ExternalCourse` with `modality: kit`.

**CourseSection**. Ordered grouping inside a course (unit, chapter, week).
`courseId`, `title`, `sortOrder`. One level is enough; deeper structure is a
new course.

**Lesson** (STI base). The unit of work a learner completes. `sectionId`,
`title`, `body` (markdown), `sortOrder`, `estimatedMinutes = 0`,
`difficulty = 0.0`, `modality`, `completionRule` (`attest`, `submit`, `score`,
`external`). Subclasses:

- `Reading`: body is the content.
- `Video`: `videoAssetId` or `videoUrl`.
- `Worksheet`: printable. `printableAssetId` (PDF), optional
  `answerKeyAssetId`, `pages = 0`. Completion rule defaults to `submit`.
- `Exercise`: interactive, usually external (`externalUrl`); Khan practice
  sets land here.
- `Assessment`: has questions and a passing score; see below.
- `Project`: free-form deliverable graded by rubric.
- `Game`: `gameKey` naming a registered game, `targetScore = 0`.

**LessonAsset**. Noun-specific owned-asset join (`lesson_assets`) per the
asset ownership rule: `lessonId`, `assetId`, `relationship` (`printable`,
`answer-key`, `video`, `attachment`), `sortOrder`.

**Question** (STI). Belongs to an `Assessment` (or a `Worksheet` when its
answer key is structured). `lessonId`, `prompt`, `sortOrder`, `points = 1`,
`skillId`. Subclasses: `MultipleChoice` (`options`, `correctIndex`),
`ShortAnswer` (`acceptedAnswers`), `Numeric` (`answer = 0.0`,
`tolerance = 0.0`), `FreeResponse` (`rubric` JSON). Printable assessments are
rendered from questions to PDF plus an answer key.

**Skill**. What a lesson teaches, as a hierarchy (`SmrtHierarchical`):
`name`, `slug`, `subject`, optional `externalCode` (Common Core id, Khan skill
id). Skills are the vocabulary that mastery, suggestions, and the tutor speak.
They are their own model rather than tags because mastery rows hang off them.

**LessonSkill** (`SmrtJunction`). `lessonId`, `skillId`, `weight = 1.0`.

**CourseSource**. Where a catalog entry came from and how to refresh it:
`key`, `name`, `kind` (`manual`, `url`, `adapter`), `adapterKey`, `config`
JSON. Khan Academy has no public API; the v1 adapter is a URL-plus-metadata
form and a later one can use the `spider` repo. CrunchLabs boxes are entered
by hand once per box and shared at the group level.

### Learner: who is learning and what they did

**Learner**. `profileId` (Person), optional `userId`, `displayName`,
`birthDate`, `level = 0` (current level in the same scale as course bands),
`settings` JSON (guarded get/set helpers; tutor preferences, UI mode).
Guardianship is a `ProfileRelationship`, so the package has no `parentId`.

**Curriculum**. A learner's plan for a period: `learnerId`, `title`,
`startsOn`, `endsOn`, `status`. One active curriculum at a time; a new school
year is a new curriculum. This is the "each kid has their own curriculum"
object.

**Enrollment**. `curriculumId`, `learnerId`, `courseId`, `status`
(`planned`, `active`, `paused`, `completed`, `dropped`), `startedAt`,
`completedAt`, `targetMinutesPerWeek = 0`, `sortOrder`. `conflictColumns`
on `(curriculum_id, course_id)`.

**LessonProgress**. One row per learner and lesson: `learnerId`, `lessonId`,
`enrollmentId`, `status` (`not_started`, `in_progress`, `submitted`,
`needs_review`, `complete`, `skipped`), `startedAt`, `completedAt`,
`timeSpentSeconds = 0`, `attempts = 0`, `bestScore = 0.0`.

**Submission** (STI). The evidence. `learnerId`, `lessonId`, `progressId`,
`submittedAt`, `status` (`captured`, `extracting`, `needs_review`, `graded`,
`rejected`), `notes`. Subclasses:

- `ScannedSubmission`: photos or scans. `pageCount = 0`, `ocrText`,
  `extracted` JSON (answers the extractor believed it found, with confidence).
- `OnlineSubmission`: `answers` JSON keyed by question id.
- `ExternalCompletion`: `reportedBy` (`learner`, `guardian`, `source`),
  `evidenceUrl`, `reportedScore = 0.0`.
- `Attestation`: a guardian says it was done. No payload.

**SubmissionAsset** (`submission_assets`). `submissionId`, `assetId`,
`relationship` (`page`, `attachment`), `sortOrder`.

**Grade**. The review of a submission: `submissionId`, `graderKind`
(`auto`, `ai`, `guardian`, `instructor`), `graderProfileId`, `score = 0.0`
(0–1), `pointsEarned = 0`, `pointsPossible = 0`, `rubricResults` JSON,
`feedback`, `gradedAt`. A submission can carry an `ai` grade and a
`guardian` grade; the guardian's is authoritative when present.

**SkillMastery**. `learnerId`, `skillId`, `mastery = 0.0`, `confidence = 0.0`,
`evidenceCount = 0`, `lastAssessedAt`. Recomputed by a job from grades
through `LessonSkill` weights with recency decay. Never written by hand.

**LearnerSignal**. Append-only observations: `learnerId`, `lessonId`,
`kind` (`enjoyment`, `difficulty-felt`, `frustration`, `interest`,
`time-overrun`, `retry`, `tutor-hint`), `value = 0.0`, `source`
(`learner`, `guardian`, `system`, `tutor`), `occurredAt`, `metadata`. The
learner's two-tap "how was that?" after a lesson writes `enjoyment` and
`difficulty-felt`; the system writes the rest.

**LearnerAttribute**. The derived profile: `learnerId`, `key`
(`interest:space`, `prefers:printable`, `frustration-threshold`,
`challenge-zone`), `value` JSON, `confidence = 0.0`, `derivedFrom`
(signal ids or job key), `updatedAt`. Recomputed by a job; v1 can be rules,
later an AI reflection in the personas pattern.

**Suggestion**. `learnerId`, `courseId` or `lessonId`, `score = 0.0`,
`reasons` JSON (`level-band`, `skill-gap:fractions`, `enjoys:building`,
`difficulty-fit`), `policyKey`, `status` (`open`, `accepted`, `dismissed`),
`generatedAt`. Suggestions are rows so guardians can see why, accept into the
curriculum, or dismiss, and so dismissals feed back as signals.

### Rewards

Kept in `src/rewards/` of the education package for v1 and extracted to its
own package when a second consumer (training, or another app) needs it; the
trigger is the second consumer, not a date.

- Points: one `smrt-ledgers` account per learner. Earning rules are a
  `RewardRule` row: `trigger` (`lesson-complete`, `streak`, `mastery-up`,
  `grade-above`), `points = 0`, `condition` JSON, scoped per tenant so a family
  can tune it.
- `Badge` (definition) and `EarnedBadge` (`learnerId`, `badgeId`,
  `earnedAt`, `evidenceId`).
- `Reward` (what points buy: `game-time`, `item`, `privilege`; `cost = 0`
  points) and `Redemption` (`learnerId`, `rewardId`, `status`
  `requested`/`approved`/`fulfilled`, approver). A guardian approves.
- `Streak`: `learnerId`, `kind`, `current = 0`, `best = 0`, `lastDayOn`.
- Games are `Game` lessons. A `GameSession` row (`learnerId`, `lessonId`,
  `score = 0`, `durationSeconds = 0`, `result` JSON) is the submission for a
  game. Game-time rewards unlock the game lesson outside its curriculum slot;
  educational games also count as lessons with skills attached.

### Tutor

The tutor is smrt-chat plus smrt-personas plus the avatar starter. The
education package adds:

- `TutorSettings` per learner (stored in `Learner.settings`, edited by learner
  or guardian): tone, name, avatar, hint policy (`hint-only`, `guide`,
  `explain-after-attempt`), answer reveal policy, allowed-topic scope,
  session time cap.
- A tool set for the persona, exposed through the same data-surface tool
  machinery smrt-chat already uses: current lesson and progress, skill
  mastery, recent signals, open suggestions, and write tools that only record
  `LearnerSignal` rows (`tutor-hint`) and never grade.
- A grading assistant for guardians: given a `ScannedSubmission` and the
  answer key or rubric, propose a `Grade` with `graderKind: ai` for the
  guardian to accept or edit.
- Persona scoping: `AgentPersona.contextType = '@happyvertical/smrt-education:Learner'`,
  `contextId = learner.id`. The learner's own persona overrides the family
  default, which overrides the group default.

## The paper workflow

This is the flow that makes the product real for a homeschool, so it is spelled
out end to end.

1. Guardian adds a `Worksheet` lesson: uploads a PDF or picks one from the
   catalog. Optional answer key as a second asset or as structured `Question`
   rows.
2. Learner's dashboard shows it as "print and do". Print opens the asset.
3. Learner or guardian taps "I'm done, take a picture". The phone camera (or a
   file upload) creates a `ScannedSubmission` with one `SubmissionAsset` per
   page through the asset runtime.
4. A job runs OCR, then, if there is an answer key, asks the model to extract
   answers into `extracted` with confidence. Status moves to `needs_review`.
5. Guardian reviews on the submission screen: pages on one side, proposed
   grade on the other. Accept or edit. A `Grade` with `graderKind: guardian`
   is written, progress moves to `complete`.
6. Jobs recompute `SkillMastery`, apply `RewardRule`s, refresh `Suggestion`s.

Without an answer key, step 4 only runs OCR and step 5 is a plain attestation
with an optional score. That is the v1 path and works on day one.

## Tenancy and sharing

```
(global, tenantId null)     open-source catalog, global skills
  └─ Group tenant           co-op: shared catalog additions, group rooms, group badges
       ├─ Family tenant A   learners, curricula, progress, submissions, points
       └─ Family tenant B
```

- Catalog models resolve family → group → global by `tenantId`, the same way
  tags and facts do. A family can fork a group course into a private copy.
- Learner models are `@TenantScoped({ mode: 'required' })` and never cross
  the family boundary. Group-level views (a leaderboard, a "who finished the
  CrunchLabs box" thread) are explicit `allowCrossTenant` aggregations that
  expose only what the family opted in to share, recorded on
  `Learner.settings.share`.
- Guardians hold Memberships in both their family tenant and the group tenant;
  group discussion happens under the group tenant with the guardian's own
  identity. Learners post in group rooms only if the application allows it.

## Application

The application is a separate consumer repository forked from `smrt-start`,
like `ergot.io` and `anytown.ai`, not an app inside this monorepo. It owns:
roles (guardian, learner, group admin), the level-to-grade mapping, screens,
the game registry, the tutor persona defaults, and invitation flow. The
education package exposes recipes (`education.catalog`, `education.learner`,
`education.rewards`) so the cookbook shell can build the screens from the
generated definitions, with bespoke Svelte only for the learner dashboard, the
scan capture, and the grading screen.

## Delivery plan

Each phase ends usable. Phase 0 is the one that matters for "sooner than
later".

**Phase 0, one family can use it.** Package skeleton with Course,
CourseSection, Lesson (Reading, Video, Worksheet, Exercise), Learner,
Curriculum, Enrollment, LessonProgress, Submission (Scanned, External,
Attestation), SubmissionAsset, Grade. Manual catalog entry for Khan and
CrunchLabs links. App forked from smrt-start: family tenant, guardian login,
learner PIN, learner dashboard, print-and-scan flow with guardian attestation
and manual score, cookbook screens for the rest.

**Phase 1, the group can evaluate it.** Skill, LessonSkill, SkillMastery job,
Assessment and Question, OCR-assisted extraction and AI grade proposal,
rule-based Suggestion from level band and skill gaps, group tenant with
invitations, chat rooms, comments on courses, LearnerSignal "how was that?"
prompt.

**Phase 2, it is fun and personal.** Rewards (ledger points, RewardRule,
Badge, Reward, Redemption, Streak), Game lessons and GameSession, tutor
persona per learner with the education tool set and guardian guardrails,
LearnerAttribute reflection job, suggestions weighted by enjoyment and
difficulty fit.

**Phase 3, training courses.** `AuthoredCourse` authoring screens,
certificate issue through `HeldQualification`, instructor role, catalog
import through smrt-ingestion with a Khan adapter via the spider repo.

## Proposed issue tree

To be filed once the primitives are agreed.

- Epic: smrt-education and the homeschool learning application
  - Phase 0
    - feat(education): package skeleton, catalog models, recipes
    - feat(education): learner, curriculum, enrollment, progress models
    - feat(education): submissions, submission assets, grades, scan capture service
    - feat(app): fork smrt-start, family tenant, guardian + learner PIN auth
    - feat(app): learner dashboard and print-and-scan flow
  - Phase 1
    - feat(education): skills, lesson skills, mastery job
    - feat(education): assessments and questions, printable rendering
    - feat(education): OCR extraction and AI grade proposal jobs
    - feat(education): rule-based suggestions and learner signals
    - feat(app): group tenant, invitations, rooms, course comments
  - Phase 2
    - feat(education): rewards module
    - feat(education): game lessons and sessions
    - feat(education): tutor tool set and guardian guardrails
    - feat(education): learner attribute reflection
  - Phase 3
    - feat(education): authored course tooling and certificates
    - feat(education): ingestion adapters for external catalogs

## Decisions needed

1. Package name: `smrt-education` with `Course` as the model (recommended)
   versus `smrt-courses`. "Education" leaves room for skills, rewards, and
   tutor tooling without a second package.
2. Rewards inside the education package for now (recommended) versus a
   separate `smrt-rewards` from the start.
3. Application as a separate forked repository (recommended) versus an app
   inside the monorepo.
4. Whether learners get their own User rows at all in v1, or only PIN sessions
   under a guardian's device. Recommended: PIN only in v1; Users when a learner
   needs their own device or the group allows learner posting.

## Open questions

- Khan Academy content cannot be embedded or imported; lessons link out and
  completion is reported by the learner or guardian. Confirm that is acceptable
  for v1, since Khan's own mastery data stays in Khan.
- Whether skills should seed from an existing standard (Common Core, or Khan's
  public skill names) or start empty and grow from what gets taught.
- Video lessons: host our own assets, link to YouTube, or both.
