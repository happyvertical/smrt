# Workbook behavior/test matrix

Design derived from the approved Hearth workbook plan (2026-10-22), learning-record
contract and WB-001–WB-019 preparation packet (2026-10-23). Feature-class additive
schema/API change, Refs #4334. Named risk: private learner evidence, authorization,
concurrency and structured external model output. No breaking Submission/Grade change.

Every row uses current actor-bound service context, exact tenant/learner resources,
and the same authorization callback executor as persistence. Shared command C:
`pnpm --filter @happyvertical/smrt-education exec vitest run workbook-service.test.ts`.
Shared command P: `pnpm --filter @happyvertical/smrt-education test:postgres` (integration
owner provisions PostgreSQL). Source assertions live in `workbook-workflows.ts` and
are shared without dialect-dependent logic. Worker evidence is SQLite/Node26;
PostgreSQL execution is explicitly pending integration, never inferred from skips.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Data executor/transaction | Supported runtime/dialect | External contract edge | Test level | Validation command |
|---|---|---|---|---|---|---|---|---|---|
| Explicit workbook/page identity | Guardian resolves named physical workbook | Same keys return same activity; repeated label in different section and edition stays distinct; pages share workbook enrollment | Changed title/edition on same key rejected; learner cannot plan | Guardian allowed; learner, sibling, foreign denied | Serialized composite write, learner row lock and unique key; rollback test | Node26 SQLite/PostgreSQL | User-confirmed keys, no photo matching | Service integration | C, P |
| Durable capture and policy snapshots | Own learner uploads/corrects | Private assets/hashes/page bounds, retained policyVersion; correction retains episode | Changed retry bytes/help; wrong predecessor; transaction abort leaves no authoritative workbook activity | Own learner/guardian allowed; exact ownership rechecked | Existing capture/storage compensation inside education transaction | Node26 SQLite/PostgreSQL | SubmissionPage MIME/bytes; absent assistance defaults unknown | Service integration | C, P; inherited submission rollback suite |
| Immutable review/authority | Guardian confirms/overrides exact revision | Immutable AI + guardian revisions; source revision, reason, actor/time retained; current review makes Grade | Learner grading; stale expected head; update/delete immutable history rejected; historical review cannot grade successor | Guardian grade required | Both queues serialized; same-scope concurrent decisions; swallowed failure rolls back Grade/revision | Node26 SQLite/PostgreSQL | Unknown result enum, malformed points/JSON, foreign sources fail | Service integration | C, P |
| Feedback policy/release/delivery | Timeline, explicit release, authenticated render acknowledgment | Gate-off AI provisional; gate-on exact release; historical availability retained; render dedup per actor/revision | Withheld payload absent; ordinary getSubmission grade redacted; stale release/head/changed retry; guardian cannot attest learner delivery | Guardian full history; own learner projected; sibling/foreign denied | Immutable release/delivery transaction; no Grade on release/direct mode | Node26 SQLite/PostgreSQL | Missing optional certainty defaults unknown, request keys bounded | Service integration | C, P |
| Durable timeline and evidence locator | Education activity read after new service instance | Full history loads without ingestion reference, cursor and exact revision selector | Unknown cursor/revision and learner selector denied; no source URI | Exact tenant/learner; guardian revision locator | Read projection from education rows/assets only | Node26 SQLite/PostgreSQL | Ingestion service absent entirely for history | Service integration; actual restart/retention remains app acceptance | C, P |
| Real question DTO transfer | Public completed generation preservation helper | Provider/model/config/source pin retained; evidence IDs mapped by retained original hash; duplicate import reuses revision, reanalysis keeps attempt | Pending/failed creates no assessment; malformed unsupported+incorrect and unassessed/zero return typed needs_review; contradicted model totals are ignored and exact2of4 yields0.5; hallucinated rectangles discarded; foreign evidence or changed source rejected | Authorized submit bound exact activity/submission/intake | Ingestion read before education transaction, append-only education revision | Node26 SQLite/PostgreSQL | Strict handler JSON schema; no prose parser; model vocabulary cannot mint concepts | Contract + real education persistence; provider accuracy N/A here (synthetic DTO) | C, P; real provider QA integration separately |
| Unknown is not wrong | Unreadable, unanswered, absent or context-free question | Explicit unassessed/null points, unknown help | Unknown enum/concept, out-of-page anchor, uncertain marking with score, unanswered zero rejected | Authorized submit; guardian confirms evidence | Validated immutable body before save | Node26 SQLite/PostgreSQL | Bounded schema/anchors/concepts; original asset hash and actual PDF page bound | Service integration | C, P |
| Descriptive learning evidence | Guardian summary after wrong→assisted correction | Independent first incorrect separated from assisted correct; one episode; exact question/revision citations | Retry/reanalysis does not create practice; unassessed excluded from error counts; corrections never independent | Guardian-only first milestone | Deterministic fresh reduction over effective guardian revisions; provisional separate | Node26 SQLite/PostgreSQL | Curated server vocabulary; mapping proposed until guardian review | Reducer exercised through persisted service | C, P |

Evidence outputs are external to source:
`/Users/will/Work/tmp/hearth-upgrade-20261025/evidence/education-workbook/`.
The coordinator records exact final commit and integrated review/PG/app/provider
results. These synthetic contract tests do not establish handwriting accuracy,
actual device camera quality, deliberate deletion/export or backup/restore policy.

Real synthetic provider regression (2026-10-25): unsupported+incorrect is rejected,
model score0.75/three-correct narrative is ignored when question evidence is2of4,
whole-source geometry replaces unverified generated rectangles and PDF source-only
anchors have page:null. The shared workbook suite covers these as executable
regressions. A completed structured proposal rejected on educational semantics
remains in ingestion history. Malformed wire responses may retain only safe
diagnostics; without raw values a page-minimum failure cannot identify null
versus zero or prove a generic validator defect.

The source-only wire regression uses the public IngestionService preview API
and its generic handler schema validator on a real retained workbook receipt.
A JSON-roundtripped evidenceId-only proposal is accepted; malformed result/reason
and an extra page selector are rejected. Image anchors are page1; PDF source-only
anchors remain page:null. No conclusion about the unknown malformed provider
page value is inferred from the earlier minimum diagnostic.

Executor affinity regression: direct catalog read/private/answer-key callbacks
receive the exact shared public collection.db executor. Mixed catalog executors
fail before host authorization. Nested workbook guardian review asserts catalog
and learner callbacks share the same active transaction. A real PostgreSQL plus
SessionService heartbeat regression belongs to the host integration lane; synthetic
SQLite affinity alone is not proof that a pooled session lock can never deadlock.

Preservation regression uses actual public IngestionService generation with an
injected synthetic generator and actual WorkbookService persistence. It proves
the raw stale-snapshot guard still rejects after grading while preservation skips
the imported revision, allows a genuinely new provisional reanalysis, and keeps
review/release/correction history and child feedback gates intact after public
receipt expiry. Legacy stale/unavailable scratch is retained; novel stale analysis
is not imported; unexpected database errors propagate. This is service-integrity
evidence, not live-provider accuracy evidence.
