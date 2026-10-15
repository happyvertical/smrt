# Issue 3969 design and test contract
Risk high: tenant authorization, asset ownership, transaction atomicity.
SubmissionService extends the owning LearnerService via protected transaction and authorization hooks. Host authorizers remain trusted code, request objects remain identifier-only. No raw executor/model returns from public methods. Submission writes use the same queue and enrollment lock. Grade authority requires a non-own verified relationship plus host permission. PDF processing uses pdf-lib; input ranges are inclusive one-based, disjoint, within document bounds, unique worksheet lesson targets in an exact-owned personal-use-copy course.
Database metadata is atomic. Storage is external and compensated on ordinary abort, including partial write. Only fresh unique asset IDs enter cleanup ledger. Cleanup failure returns explicit diagnostic with asset IDs for operator recovery; crashes require orphan reconciliation, never claimed as distributed atomicity.

| behavior | trigger | positive | failure | actor/context | executor | dialect | external edge | level | command |
|---|---|---|---|---|---|---|---|---|---|
| capture ownership | capture uploads | own/guardian matching enrollment submitted | sibling/cross-family/context spoof/mismatched lesson deny | exact actor, membership, guardian relationship+host | same transaction enrollment lock | SQLite/PostgreSQL | malformed/empty uploads | integration | package test/test:postgres |
| atomic capture | second file failure | pages and matching progress committed | partial storage/DB failure cleans files and rolls back, retry succeeds | own | queued txn | SQLite/PostgreSQL | storage write/delete failure | integration | package test/test:postgres |
| fresh storage ownership | custom resolver maps new asset to shared URI | fresh UUID locator preserved | shared URI denied before write and existing bytes survive composed rollback | authorized learner, trusted provider | same transaction and post-rollback compensation | SQLite/PostgreSQL | resolver collision/partial write | integration | package test/test:postgres |
| grading authority | attest/review | guardian completes and nullable/zero score | learner grade injection, relationship/host deny, invalid score | verified guardian | same txn/lock | SQLite/PostgreSQL | unknown enums denied by model | integration | package test/test:postgres |
| asset URL ownership | sign submission page | scoped signed claim | sibling, foreign, corrupt join, foreign asset deny | exact owner | read only | SQLite/PostgreSQL | trusted signer errors propagate | integration | package test/test:postgres |
| PDF splitting | upload packet ranges | real extracted PDF pages owned by matching private lessons | invalid/overlap/out of range/nonprivate/nonworksheet fail, cleanup | guardian only | same txn | SQLite/PostgreSQL | pdf-lib malformed PDF | integration | package test/test:postgres |
| closed model/export contract | load models/public bundle | STI and guarded JSON, all exported | direct generated API closed, invalid persistence identity | trusted persistence | model executor | SQLite/PostgreSQL | consumer bundle export | contract | package build/typecheck/verify:pack |
| transaction lifecycle | composed calls | serialized/drained | poison/escaped service/rollback reject | authorized | parent queue | SQLite/PostgreSQL | N/A no new network boundary | integration | package test/test:postgres |

## Executable coverage

`src/__tests__/submission-workflows.ts` supplies capture, grading, queue,
uncertain-commit, rollback, cleanup-failure, shared-storage denial, host-denial and packet scenarios to
both `submission-service.test.ts` (SQLite) and `submission.optional.test.ts`
(PostgreSQL). `submission-model-workflows.ts` exercises STI hydration, ownership,
invalid enum/score/points and guarded JSON. `submission-contract.test.ts` checks
all six closed model registrations and the public service export. Existing
learner workflows continue to cover context spoofing, inactive memberships,
corrupt parent links, answer-key request whitelisting and in-flight drain.

The capture regression also verifies learner fixture catalogs are tenant-owned.
The previous fixture from parent `9620ebe289d3ba69da5e44efc4566083e1f03753`
created global courses through a root executor; PostgreSQL fixture cleanup could
not roll these commits back. Running learner suites before catalog pagination
exposed an extra global course. The nearby fixture fix scopes seven records to
the fixture family, preserving a root executor for real transaction coverage.
The base-fixture comparison restores only that exact parent fixture file while
running the current assertion, then restores the fixed file; it is not a claim
that the entire new submission suite runs on the parent API.

## Release scope

Node 26.10.0 and pnpm 11.25.0. Package build, full SQLite suite, real PostgreSQL
wrapper, typecheck, pack/type export and public-consumer checks are required.
Relevant root lint/format, strict knowledge, agent-chain and audit-policy gates
also apply. Core embedded transaction queue regressions cover the reused owning
transaction primitive. No UI/browser surface changed. Full-root aggregate
build/test/typecheck are not claimed: production edits remain education-only.
Full DuckDB workflows remain unsupported due to the existing catalog DDL gates.
`pdf-lib` 1.17.1 (MIT) is the concrete PDF dependency, already present in the
workspace lock graph; no new transitive version resolution was introduced.
CI and required approval checks remain post-publication gates.

## Review round 3 accepted blockers

- Private-material authoring: real generated Asset REST positive control exposes
  ordinary public metadata, but public answer-key/personal-copy joins are denied;
  scoped private joins succeed while generic REST/MCP excludes their URI.
- Exact owner/tenant capability, missing capability, join relationship updates,
  course license changes and section/lesson reparenting fail closed. Authorized
  packet splitting remains a positive control on SQLite and PostgreSQL.
- Guarded natural-key writes never adopt an unrelated explicit ID. SQLite,
  DuckDB, and PostgreSQL NULL-key collision checks preserve original rows;
  existing public natural-key upsert and interleaved private collision tests
  remain required.
