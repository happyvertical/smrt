# Material generation proposals and educational review

`CourseGenerationReviewService` (SMRT #4516, extends `QuestionAuthoringService`,
consumed by Hearth #68) adds generation proposals and revision-bound review to the
course contract. Risk is high: schema and public contract. It uses the same
authorizer, tenancy checks and compare-and-swap save path. Every call receives
the transaction executor and `operation` (`request-generation`, `run-generation`,
`cancel-generation`, `accept-proposal`, `read-generation`, `record-review`,
`resolve-finding`, `note-context-change`, `read-review`). Foreign ids are not found.

## Models (closed, required tenant, no REST/CLI/MCP/AI, append-only)

`CourseGenerationJob` (request plus retained input snapshot),
`CourseGenerationEvent` (status log: queued, running, succeeded, failed,
cancelled; provider, model, response model, nullable token/cost usage, error
code, outcome), `CourseProposal`, `CourseProposalDecision`, `CourseReview`,
`CourseReviewFinding`, `CourseReviewOutdatedMarker`, `CourseFindingResolution`.
`save()` on an existing row and `delete()` throw. Eight additive tables, test-pinned;
the runtime never creates tables. `CourseReview` has no score, rating or grade.

## Generation

The host injects a `CourseMaterialGenerator` (`createProposalCourseGenerator`
adapts an ingestion `ProposalGenerator`); the service never selects a provider.
`requestGeneration` (action `education.course.generate`) records a job against the
head the caller saw; the request key is idempotent, a retry or duplicate returns
the existing job and proposal, and the same key with other input throws
`CourseRequestKeyConflictError`. `runGeneration` calls the generator outside any
transaction (deadline and output cap), then validates the untrusted output against
a closed schema. Invalid output, provider error, timeout, cancellation or a moved
head record `failed`/`cancelled` and leave the head unchanged; the input stays.
Personal-use lesson bodies and assets are never sent to the provider.

Success appends one new draft revision (`generate` plus `author`, provenance
`generated`) holding only additions and fills of empty fields. A proposal that
differs from supplied content is a `conflict` and is held in `CourseProposal`.
`getProposal` returns the per-field comparison (supplied, proposed, current,
decision). `decideProposal` accepts or rejects conflict fields: an accept appends
a revision on `expectedHeadRevisionId` and records the decision; supplied content
is replaced only that way. Never write generated content to a released revision or
assign it to a learner.

## Structured requests and one-lesson generation

`requestGeneration` also takes an optional `brief` (`CourseGenerationBriefInput`)
next to the free `instruction`: `target` (`'course'`, the default and today's
behaviour, or `'lesson'`), `subject`, `category`, `area`, `grade` (whole 0-12),
`objective`, `learningObjectiveId`, `learnerId` and a per-request `theme`
(`{ label, key? }`). Text is bounded and sent to the provider as data. A request
without `brief` behaves exactly as before and `brief` reads back `null`.

- **Objective.** A `lesson` target needs an objective (`objective`, else `area`);
  without one `CourseGenerationBriefError` is thrown before anything is written.
  The objective is stored on the job's `CourseGenerationBriefRecord`, sent in the
  generation brief as fixed, and copied verbatim onto the proposed lesson. The
  theme changes story and examples only: output that states a different
  objective fails the job (`CourseGenerationOutputError`).
- **Theme.** The per-request `theme` is an override that wins for that request
  only. Without one the learner's saved `interestTheme` (read-only, from
  `brief.learnerId`) applies; with neither there is no theme. The brief records
  `theme` and `themeSource` (`'override' | 'saved' | 'none'`) at request time, and
  `CourseGenerationView.brief` / `CourseProposalView.brief` show it to the
  guardian reviewing. Nothing in generation writes to the learner, so the saved
  preference is never changed, on success or failure.
- **Authority.** The host authorizer is asked for `education.course.generate`
  with `learnerId` in the context so it can enforce its own "may this learner ask
  for a lesson" policy; an unknown or foreign-tenant learner is `CourseNotFoundError`.
  The package does not check the requester's relationship to `brief.learnerId` (the
  brief echoes that learner's saved theme): the host authorizer MUST deny `generate`
  when the actor is not that learner or a guardian with an effective relationship, as
  it does for `assign`.
  Replaying a request key with the same brief returns the same job; a changed
  brief is `CourseRequestKeyConflictError`.
- **Output.** For `lesson` the generator is given `request.brief` and
  `COURSE_LESSON_PROPOSAL_ARGS_SCHEMA` (via `createProposalCourseGenerator`):
  exactly one new lesson with `title`, `body` (the themed explanation) and
  `questions` (worksheet; every question needs an `answerKey`), and no course-level
  fields. The worksheet becomes immutable question records, linked to
  `learningObjectiveId`, in the same transaction as the draft revision; answer keys
  stay out of learner views. Review, `decideProposal` and release are unchanged.
- **Approving requested lessons.** The package has no per-learner setting. To honour
  the host's own "approve requested lessons" setting without bypassing authority,
  the host calls `recordReview` then `release` under the guardian delegation as for
  any course, passing `policyBasis` (for example `'auto-approve-requested-lessons'`)
  to `release`, or returning `policyBasis` from its authorizer decision (the two
  must agree). The basis is recorded on `CourseRelease.policyBasis` and
  `CourseReleaseView.policyBasis`; it grants nothing and the review gate, the
  `education.course.release` grant and the delegation check still apply. The
  explicit alternative, a guardian approving each lesson, is the existing
  `recordReview` plus `release` by the guardian.

Additive schema: table `course_generation_briefs` and column
`course_releases.policy_basis`. On a host without the table, plain requests still
work and structured ones fail closed with `schema-unavailable`.

## Review

`recordReview` (action `education.course.review`) binds to an exact revision and a
context digest (level target and theme from the revision; learner plus evidence
snapshot reference when given). Findings point at a course, lesson or question
revision id plus field/region, with concern, explanation, suggested change,
`uncertain`, `humanVerificationRequired` and `blocking`. Sections are separate:
`general-level` and `individual-learner` (needs a learner context). Every review
stores `COURSE_REVIEW_DISCLAIMER`; it is an aid, never certification.

A review is outdated when a new draft revision is saved (a persisted marker is
appended inside that save), when `noteContextChange` reports a new evidence
snapshot, or when the head differs or the digest no longer verifies (derived).
History, authorship (actor plus delegating guardian) and findings are kept.
`resolveFinding` records one resolution per finding; a delegated agent cannot
resolve a `humanVerificationRequired` finding.

## Release gate and discard guard

`createReviewBackedReleaseGate()` (the service default) makes a revision releasable
only when its latest review is for that revision, is the draft head, has no marker,
a matching digest, and no unresolved blocking or human-verification finding on
any review of it or of any ancestor revision (a newer or empty review never hides
one). Nothing drops a finding automatically: not an edit, rename, copied question
or removal of its target. Only `resolveFinding` clears one (a guardian can, even
when the target is gone; a delegated agent cannot resolve human-verification
findings); otherwise `ReviewNotCurrentError.reason` is `no-review`, `outdated`,
`context-mismatch` or `unresolved-findings`. A plain `CourseAuthoringService`
without a gate still fails closed. `createCourseReferenceGuard(extra)` blocks
discard for review and generation rows; pass variant guards through `extra`.

## Evaluation

`evaluateReviewer(cases, reviewer)` scores a supplied reviewer function against
seeded flaws and suitable material (precision, recall, false-alarm rate, per
category). Fixtures live in `src/__tests__/course-review-fixtures.ts`; no live model
is called by this package.
