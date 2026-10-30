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
any review of it (a newer or empty review never hides one) or carried from an
ancestor revision's reviews while its target lesson/question revision or course
field is still unchanged (changed or removed material drops it; only
`resolveFinding` clears one);
otherwise `ReviewNotCurrentError.reason` is `no-review`, `outdated`,
`context-mismatch` or `unresolved-findings`. A plain `CourseAuthoringService`
without a gate still fails closed. `createCourseReferenceGuard(extra)` blocks
discard for review and generation rows; pass variant guards through `extra`.

## Evaluation

`evaluateReviewer(cases, reviewer)` scores a supplied reviewer function against
seeded flaws and suitable material (precision, recall, false-alarm rate, per
category). Fixtures live in `src/__tests__/course-review-fixtures.ts`; no live model
is called by this package.
