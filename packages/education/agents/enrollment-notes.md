# Enrollment parent notes

`LearnerPlanService` provides `listEnrollmentNotes` and `addEnrollmentNote` on
its existing actor-bound learner transaction boundary. Both require an exact
owning tenant, learner and enrollment plus a verified directed guardian
relationship. Own learners are always denied, even with a permissive host grant.
The host must authorize `education.learner.notes.read` and
`education.learner.notes.add`, verifying the current relationship type, terms,
session and permission using the supplied exact `executor`. Membership alone
never grants note access. Catalog access does not grant note authority.

Add accepts `{ ...LearnerRequest, enrollmentId, text, requestKey }`. Text is
nonblank, at most `ENROLLMENT_NOTE_MAX_LENGTH` (4000 UTF-16 code units), and
retained verbatim as plain text; render with text escaping, never as HTML or
markdown. Control characters other than tab/newline/carriage return are rejected.
The request key is nonblank, at most 200 code units, without control characters.
Author, author label and creation time are server-derived; extra request properties are ignored.
The data-only result is `{ id, enrollmentId, learnerId, text, authorUserId, authorLabel,
createdAt: Date }`. List order is creation time then id.

Notes are append-only. Retrying the same tenant/enrollment/requestKey and text
returns the original row, author, label and time; changing text rejects. PostgreSQL
serializes writes on the enrollment row and uses a natural-key unique index;
embedded databases use the owning service transaction queue. Notes share
`withTransaction` / `withExecutor`, including rollback and poisoned mutations.
No progress, submission, assessment, feedback or learning history changes occur.

`EnrollmentParentNote` and its collection are trusted persistence APIs, never
request handlers. Generated REST, CLI, MCP and AI surfaces are closed. Persisted
model saves and deletes reject; creation uses strict insert so natural-key
collisions cannot rewrite provenance. The internal persisted `recordedAt` maps
to DTO `createdAt`. Hosts must use the service to derive provenance and authority.
Normal additive manifest migration creates `enrollment_parent_notes`.

`src/__tests__/enrollment-note-workflows.ts` contains shared SQLite/PostgreSQL
assertions for authority, provenance, validation, concurrency and transactions.
No full DuckDB workflow support is claimed.

`authorLabel` snapshots only the validated actor User's linked Profile name on
creation, using the same executor. Trim it and cap it at 200 code units; absent
or blank names use `Parent`. List and retry return the persisted label without
looking up previous authors, so later profile renames never rewrite history.
