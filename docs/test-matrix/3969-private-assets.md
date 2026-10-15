# Private education assets: test design contract

Issue #3969, external P1 on PR #4000. High risk: tenant authorization, private
storage ownership, atomic persisted mutation. This extends the existing submission
contract; it does not change grading permissions. The user requested consolidation
of the reviewed education components into one PR.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level | Validation |
|---|---|---|---|---|---|---|---|---|---|
| Private records hidden before pagination | Generated Asset REST/MCP list/get, collection count/projection, parent hydration | Public assets still list/get | Private record/locator absent, private update denied | Ordinary tenant actor, sibling-equivalent actor; system has no implicit capability | Real root executor | Node; SQLite | REST responses and MCP tool envelopes | Integration | Assets private-asset-access test |
| Exact private capability | Trusted host authorizes owner and IDs | Matching actor/tenant/owner/ID can read/update | Other ID/owner, actor switch, widened nested scope, expired async continuation fail | Authenticated actor bound to active tenant | Same root or transaction executor | Node; SQLite | Server-only API; never request JSON | Integration | Assets private-asset-access test |
| Immutable classification/ownership | Forged model save, generated patch, direct delete | Authorized private update retains owner/mode | Downgrade, wrong owner, no capability fail | Explicit private capability required even for system | Persisted check uses instance executor | SQLite/PostgreSQL | Null/unknown access modes invalid; legacy rows public after migration | Integration | Assets private-asset-access and education privateWriteGuard |
| Atomic late-conflict denial | Public natural-key create races private commit | Public natural-key upsert remains supported | Private source/owner/mode unchanged after losing public writer | Same tenant, no private capability | Two PostgreSQL connections; private transaction holds commit until public final insert | PostgreSQL; SQLite late-insert hook delegates real SQL | Unique conflict / zero-row guarded update fails closed | Integration | Education test:postgres and submission-service test |
| Mandatory predicates preserve CAS | Save/claimRevision/delete after policy changes | Public writes and transaction-bound writes succeed | Mandatory predicate rejects even with matching revision; bulk path refuses incompatible policy | Owning interceptor supplies predicates; caller options cannot override | Real executor; embedded shared queue and final PostgreSQL SQL | SQLite/DuckDB/PostgreSQL | Unsupported affected-row result cannot be claimed successful | Integration | Core mandatory-write-guard and existing revision suites |
| Private capture and packet creation | Learner upload or guardian PDF split | Each new page private from insertion, exact authorized signing works | Ordinary Asset APIs cannot retrieve pages; capture/storage failures compensate | Learner own work; guardian actual relationship plus host decision | Submission/enrollment/asset metadata one transaction | SQLite/PostgreSQL | Private provider ACL required; HTTP(S) locator rejected; cleanup failure remains diagnosed/retryable | Integration | Education test and test:postgres |
| Guard cannot be bypassed by raw collection SQL | AssetCollection.query and global helpers | Global/tenant+global public helpers retain results | Arbitrary raw Asset SQL rejected, including scope-bearing calls | Normal tenant context retained | Root collection executor | SQLite; full root compatibility suite | Direct DB is trusted infrastructure, not an exposed request API | Integration | Assets collection/isolation/private tests, root test |

The owning privacy policy is imported with Asset itself. No education-only setup,
closed-STI assumption, field-only redaction, schema creation at runtime, disabled
generic asset APIs, or storage ACL inference from a hidden URI is used. Public
HTTP(S) sources remain valid for ordinary public Asset records.

Migration: explicit generated schema migration adds `access_mode` with public
default. Existing legacy records retain their visibility; rebuild downstream
manifests before deploying. No standalone low-cardinality access-mode index is
needed: exact operations use primary keys and scoped lists retain tenant indexes.

Evidence lives in the immutable review packet, including complete command logs,
base behavior comparison, pinned Node/pnpm runtime, exact reviewed commit, full
main-to-head diff, prior component coverage and conflict resolutions. The existing
review cycle is retained; material owning-core mutation changes escalate round 2
to the full high-risk roster.
