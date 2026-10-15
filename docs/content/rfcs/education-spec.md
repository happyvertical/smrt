# RFC: `@happyvertical/smrt-education`

Tracking issue: [#3964](https://github.com/happyvertical/smrt/issues/3964).
Status: accepted; primitives and the decisions below are settled, phases
are filed as issues under the epic.

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
| Group → family tenants | `smrt-users` Tenant hierarchy, `smrt-tenancy` | The co-op is a tenant; each family is a child tenant. Existing `Tenant.getAncestorIds()` and `TenantCollection.getAncestors()`, `getDescendants()`, and `isAncestorOf()` remain the traversal source. Catalog rows are global (null tenant), group-shared, or family-private. |
| Adults sign in, kids do not | `smrt-users` Membership, `DeviceCredentialService` | A guardian has a Membership in the family tenant and the group tenant. A learner is a Person profile with its own User (email optional) and family Membership. Shared-device learner access is a terminal/device grant verified with that User's PIN after host enrollment; a guardian password session alone is not that grant. |
| People and family relationships | `smrt-profiles` Person, `ProfileRelationship` | Learner and guardian are Profiles; guardianship is a relationship, not a field. |
| Worksheets, scans, photos, videos | `smrt-assets` AssetRuntime, `@happyvertical/ocr`, `@happyvertical/pdf` | Printable lessons own a PDF asset. Scans are assets on a submission. OCR and PDF rendering run as background jobs. |
| Discussion group, messaging | `smrt-chat` rooms and threads, `smrt-comments`, `smrt-messages` | Group rooms live in the group tenant. Comments attach to courses and lessons (reviews, suggestions). Messages deliver notifications and direct mail. |
| Interactive tutor | `smrt-chat` agent sessions, `smrt-personas`, `smrt-agents`, `smrt-voice`, `smrt-avatar-starter` | One `AgentPersona` per learner, context-scoped to the Learner record, customised by learner or guardian. The education package contributes the tutor's tools and guardrails, not the chat stack. |
| Points and rewards | `smrt-ledgers` | Points are an integer ledger account per learner. Badges, rewards, and redemptions are the only new rows. |
| Background work | `smrt-jobs` | OCR, extraction, mastery recalculation, suggestion refresh, reminders. |
| Catalog import | `smrt-ingestion` | External sources become ingestion sources with review-before-apply; v1 can bypass it with manual entry. |
| Certificates for training courses | `smrt-human-resources` `Qualification` | A completed training course can issue a `HeldQualification`. Not needed for v1. |
| Enjoyment and interest signals | `smrt-personas` learning loop pattern | The feedback → confidence → reflection shape is reused for learner attributes, but on education's own rows. |
| Phone camera for scans | `smrt-ui` `CameraCapture` | Already upstream; the app wires it to the scan capture service. |
| First-run setup | `smrt-app-runtime` owner setup | Creates the family tenant and guardian owner. |

### Pieces to upstream first

anytown.ai and ergot.io each carry generic tenancy code that smrt still
lacks. Both apps are pinned to older smrt and also carry things that have
since landed upstream (mobile auth, camera capture, owner bootstrap, host
tenant resolution, role seeding, device PINs); those are not ported. The
genuine gaps are filed as Phase 0.5 under the epic and run alongside the
catalog models:

| Issue | From | Fills |
|---|---|---|
| [#3973](https://github.com/happyvertical/smrt/issues/3973) Invitation model and service | anytown dashboard | co-op invites by email or link; smrt has only the modal UI |
| [#3974](https://github.com/happyvertical/smrt/issues/3974) membership upsert | anytown, rewritten again in ergot | idempotent add and remove used by invites and joins |
| [#3975](https://github.com/happyvertical/smrt/issues/3975) trusted hierarchy read scope | anytown ancestor walk, ergot child-scope checks, reusing existing tenancy traversal | catalog ancestor reads and authorized group subtree aggregates |
| [#3976](https://github.com/happyvertical/smrt/issues/3976) SvelteKit guards | ergot factory dashboard, anytown | `requireTenantContext` / `requirePermission` |
| [#3977](https://github.com/happyvertical/smrt/issues/3977) approval-based join | anytown reporter onboarding | a family asks to join the co-op |

Neither app has anything for courses, lessons, sectioned authoring,
markdown editing, PDF splitting, comments, person-to-person messaging, or
shared-device user switching; those stay new work here.

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
- `licenseKind`: `own-work`, `open-license` (with `license` naming it),
  `personal-use-copy` (third-party material a family holds for its own
  use), `licensed-for-sharing` (written permission on file, `licenseNote`
  says from whom). `personal-use-copy` pins the course and its assets to the
  family tenant: no promote-to-group, no catalog listing, no public asset
  URLs. The attestation is chosen at upload and recorded with the actor.
- STI subclasses only where behaviour differs: `ExternalCourse` (completion is
  attested or reported, content lives elsewhere), `AuthoredCourse` (content is
  our lessons). A CrunchLabs box is an `ExternalCourse` with `modality: kit`.

**CourseSection**. Ordered grouping inside a course (unit, chapter, week).
`courseId`, `title`, `sortOrder`. One level is enough; deeper structure is a
new course.

**Lesson** (STI base). The unit of work a learner completes. `sectionId`,
`title`, `body` (markdown), `sortOrder`, `estimatedMinutes = 0`,
`difficulty = 0.0`, `modality`, `completionRule` (`attest`, `submit`, `score`,
`external`), `externalRef` (the source's own lesson identity, such as an
Easy Peasy day number) and `externalUrl` (the source page, with anchor, to
open for the instructions). For linked courses `body` stays empty: the
instructions live at the source and the row is a pointer plus our progress.
Subclasses:

- `Reading`: body is the content.
- `Video`: a `LessonAsset` with relationship `video`, or `videoUrl`.
- `Worksheet`: printable. The PDF is either held (a `LessonAsset` row with
  relationship `printable`, below) or pointed at (`printableUrl`, a PDF the
  source hosts). Likewise an answer key is a `LessonAsset` with relationship
  `answer-key` or an `answerUrl`. `pages = 0`. Completion rule defaults to
  `submit`. A worksheet has exactly one of held asset or URL per
  relationship; the model carries no `*AssetId` columns, so asset ownership
  has one home. The held-versus-pointed distinction is the licensing
  boundary, see "First source: Easy Peasy".
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
JSON, `sharing` (`private`, `group`, `global`): the widest tenant level an
import from this source may land in, so licensing is enforced by the
importer rather than by memory. Khan Academy has no public API; the v1
adapter is a URL-plus-metadata form and a later one can use the `spider`
repo. CrunchLabs boxes are entered by hand once per box and shared at the
group level. Easy Peasy is the first adapter, below.

### First source: Easy Peasy All-in-One Homeschool

The learner currently works through Easy Peasy, so it is the Phase 0
import path rather than Khan.

**What the site says.** The curriculum is free for anyone to use without
registration. Each course page is 180 bold "Lesson N" headings; a day with a
printable worksheet is marked with an asterisk and links a per-day PDF under
`wp-content/uploads/` (for example `LA-4-Lesson-29.pdf`), and most courses
also publish a free whole-course printables packet on the print page.
Answers are on password-protected pages linked from the lesson. The footer
and the print page carry "Copyright Lee Giles, All Rights Reserved" and a
disclaimer that the assignments, the collection of links, the structure of
the curriculum, and the files the site created may not be copied and
published to another site or used for any commercial benefit. Printables
books are sold in their store and the FAQ asks readers to report anyone
selling the worksheets.

**What that permits.** A family may print the worksheets and do the work;
the completed, hand-written pages are the learner's own work and the scans
belong to the family. What we may not do is mirror the lesson text, copy the
PDFs into our asset store, republish the day-by-day structure as a shared
catalog, or sell access to any of it. The co-op is non-commercial but
"published to another site" is the clause that bites, so group-level sharing
of an Easy Peasy index needs written permission from Lee Giles. Until then
the import is per family.

**Design consequences.**

- An Easy Peasy course is an `ExternalCourse` whose lessons are pointers:
  `externalRef` is the day number, `externalUrl` is the course page anchor,
  and worksheet days are `Worksheet` lessons with `printableUrl` set and
  no `printable` LessonAsset. Nothing from the site is stored beyond title,
  day number, and URLs that resolve to the site itself. The links Easy Peasy
  curates to third-party videos and games are not copied either; the learner
  follows them from the source page.
- The `easy-peasy` adapter fetches a course page at import time, under the
  importing family's tenant, and emits lesson rows from the "Lesson N"
  headings, the asterisk marker, and the PDF links. Its `CourseSource.sharing`
  is `private`. Re-import refreshes URLs without touching progress. It lives
  in the education package as an adapter but is only registered by
  applications that accept the terms.
- "Print" on the learner's dashboard opens the source PDF in a new tab. The
  app never proxies or caches the file. The packet PDF on the print page is
  offered as a one-time "print the whole course" link.
- Scans of completed worksheets are ordinary `ScannedSubmission`s. Grading
  in Phase 0 is guardian attestation with an optional score, since the answer
  pages are password-protected and theirs. A guardian may type the answers
  for a day into structured `Question` rows for AI grade proposals; those
  rows are family-private and never exported.
- Easy Peasy's My EP tracker only records the current day per course.
  `LessonProgress` replaces it and is strictly richer, which is the main
  reason a family would switch to this app for the same material.
- If written permission arrives, the source's `sharing` is widened to
  `group` and a guardian runs an explicit promote action on the course.
  Promotion re-tags the Course, its sections, lessons, and `LessonAsset`
  rows to the group tenant in one transaction; `Enrollment`,
  `LessonProgress`, and `Submission` rows stay in the family tenant and
  keep their foreign keys, since catalog resolution reads ancestors. Widening
  `sharing` alone changes nothing already imported; it only permits the
  promote action and future imports at that level.

**Families uploading their own copies.** A parent may upload the free
per-day PDFs or the whole-course packet into the family tenant as
`personal-use-copy`. That is the same act as saving them to a home drive:
the site invites families to print them, the family makes the copy, and a
tenant-scoped private store is not "publishing to another site". The
guardrails are the `licenseKind` pin above, signed tenant-scoped asset URLs
with no static links, and that the app treats such files as user content
the family owns, with a takedown path. A packet upload is split into
per-lesson `Worksheet` assets by page range at upload time, so one file
yields a dispensable course. Scanning the printables books sold in their
store is not supported; the free PDFs cover the same worksheets.

### Learner: who is learning and what they did

**Learner**. `profileId` (Person), `userId` (every learner has a User with a
Membership in the family tenant; email is optional on User, so a child
needs none), `displayName`, `birthDate`, `level = 0` (current level in the
same scale as course bands), `settings` JSON (guarded get/set helpers; tutor
preferences, UI mode). A shared family device still signs the learner in by
per-person PIN through `DeviceCredentialService`; the PIN is a credential on
the learner's own User, not a substitute for one. Guardianship is a
`ProfileRelationship`, so the package has no `parentId`.

**Curriculum**. A learner's plan for a period: `learnerId`, `title`,
`startsOn`, `endsOn`, `status`. One active curriculum at a time; a new school
year is a new curriculum. This is the "each kid has their own curriculum"
object.

**Enrollment**. `curriculumId`, `learnerId`, `courseId`, `status`
(`planned`, `active`, `paused`, `completed`, `dropped`), `startedAt`,
`completedAt`, `targetMinutesPerWeek = 0`, `sortOrder`. `conflictColumns`
on `(curriculum_id, course_id)`.

**LessonProgress**. One row per enrollment and lesson: `learnerId`, `lessonId`,
`enrollmentId`, `status` (`not_started`, `in_progress`, `submitted`,
`needs_review`, `complete`, `skipped`), `startedAt`, `completedAt`,
`timeSpentSeconds = 0`, `attempts = 0`, `bestScore` (optional decimal).
It is unique by `(enrollmentId, lessonId)`: the learner is derived from and
validated against the enrollment, and the lesson must belong to the enrollment
course. A new enrollment in a new curriculum/year begins a new history; it
never overwrites the old enrollment's progress or attempts. An absent score
means unscored and remains distinct from score `0`.

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
(`auto`, `ai`, `guardian`, `instructor`), `graderProfileId`, `score`
(optional decimal 0–1), `pointsEarned` (optional integer), `pointsPossible`
(optional integer), `rubricResults` JSON,
`feedback`, `gradedAt`. A submission can carry an `ai` grade and a
`guardian` grade; the guardian's is authoritative when present.

### Authorization boundary

Authorization is enforced at owning services and every generated REST, CLI,
MCP, and AI surface, not just application routes. A learner may read and submit
only their own work. An authorized guardian may review work in their family.
Learners cannot grade, alter completion status, or forge a score. Same-tenant
sibling access and cross-family access fail closed. Assets retain tenant
ownership when signed, and learner projections never include answer keys.
Generic SvelteKit tenant and permission guards from #3976 provide route
context only; they never replace object-level learner authorization.

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

1. Guardian adds a `Worksheet` lesson: imports a course whose days link to
   source-hosted PDFs, uploads a PDF we are allowed to hold, or picks one
   from the catalog. Optional answer key as a second asset, a URL, or
   structured `Question` rows.
2. Learner's dashboard shows it as "print and do". Print opens the asset or
   the source URL.
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

- Catalog models resolve family → group → global by `tenantId`. The existing
  `queryWithGlobals` pattern used by tags and facts only sees the current
  tenant plus null rows, so a group-owned course would be invisible from a
  family request. #3975 adds ID conveniences over existing traversal plus
  `requireChildOf` and `withTenantHierarchyContext` semantics for a trusted,
  explicitly authorized read-only scope. Catalog `findVisible()` uses the
  family and its ancestors plus global rows; it never reads sibling-private
  catalog records. Writes stay tenant-scoped as usual. A family can fork a
  group course into a private copy.
- Learner models are `@TenantScoped({ mode: 'required' })` and never cross
  the family boundary. An authorized group subtree aggregate is explicit and
  exposes only data each family opted in to share, recorded on
  `Learner.settings.share`; it is not an ancestor-catalog read or a blanket
  cross-tenant capability.
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

The application consumes a released `@happyvertical/smrt-education`; it does
not use a workspace, file, or Git dependency as a release workaround. Explicit
guardian terminal approval creates an enrolled-device parent session; only then
does the learner PIN create the selected learner's child session. Each learner
authentication rechecks terminal enrollment, revocation invalidates child
sessions, and learner switching clears prior learner authority. A plain guardian
password session cannot enroll a terminal or impersonate a learner.

## Delivery plan

Each phase ends usable. Phase 0 is the one that matters for "sooner than
later".

**Phase 0, one family can use it.** Package skeleton with Course,
CourseSection, Lesson (Reading, Video, Worksheet, Exercise), Learner,
Curriculum, Enrollment, LessonProgress, Submission (Scanned, External,
Attestation), SubmissionAsset, Grade, CourseSource with the `easy-peasy`
adapter importing the learner's current courses as private pointer lessons.
Manual catalog entry for Khan and CrunchLabs links. App forked from
smrt-start: family tenant, guardian login, terminal/device learner grant, a
learner dashboard selecting the next unfinished lesson across active
enrollments by `CourseSection.sortOrder`, then `Lesson.sortOrder`, then a
deterministic ID tie-break, print-and-scan flow with guardian attestation and
manual score, cookbook screens for the rest. Complete/skipped work is excluded;
submitted/needs-review work remains visible as awaiting review without a
duplicate capture action. Phase 0 has no calendar scheduler.

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

## Issue tree

Epic: [#3965](https://github.com/happyvertical/smrt/issues/3965). Phase 0
is filed; later phases are filed when Phase 0 is usable.

- Phase 0
  - [#3966](https://github.com/happyvertical/smrt/issues/3966) feat(education): package skeleton, catalog models, recipes
  - [#3967](https://github.com/happyvertical/smrt/issues/3967) feat(education): course sources and the easy-peasy page adapter
  - [#3968](https://github.com/happyvertical/smrt/issues/3968) feat(education): learner, curriculum, enrollment, progress models
  - [#3969](https://github.com/happyvertical/smrt/issues/3969) feat(education): submissions, submission assets, grades, scan capture service
  - [#3970](https://github.com/happyvertical/smrt/issues/3970) feat(app): fork smrt-start, family tenant, learner auth
  - [#3971](https://github.com/happyvertical/smrt/issues/3971) feat(app): learner dashboard and print-and-scan flow
- Phase 0.5 (upstream ports, same wave as the catalog models): #3973,
  #3974, #3975, #3976, #3977, see "Pieces to upstream first"
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

## Decisions (2026-10-14)

1. Package name: `@happyvertical/smrt-education`, directory
   `packages/education`, with `Course` as the catalog model and `Curriculum`
   as the learner's plan.
2. Rewards live in `src/rewards/` of the education package. Extraction
   trigger: a second consumer.
3. The application is a separate repository forked from `smrt-start`.
4. Every learner has a User row and a family-tenant Membership from v1.
   Shared-device sign-in is a per-person PIN on that User. This keeps the
   path open for a learner's own device and for group-room posting without
   a migration.

## Open questions

- Easy Peasy group sharing: ask Lee Giles in writing whether a non-commercial
  co-op may share a day-number-and-link index of a course between families.
  The design works either way; permission only widens `sharing`.
- Khan Academy content cannot be embedded or imported; lessons link out and
  completion is reported by the learner or guardian. Confirm that is acceptable
  for v1, since Khan's own mastery data stays in Khan.
- Whether skills should seed from an existing standard (Common Core, or Khan's
  public skill names) or start empty and grow from what gets taught.
- Video lessons: host our own assets, link to YouTube, or both.
