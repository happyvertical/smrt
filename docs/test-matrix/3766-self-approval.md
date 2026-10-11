# #3766 permission-gated self-approval

Risk: high (authorization boundary). Only authenticated human principals may decide;
the opt-in permission supplements all existing permissions. Ledger writes remain
service-only and atomic with guarded request transitions. Raw SQL writers remain
outside the trust boundary. Historical authorized votes survive permission changes.

| Behavior / reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level / command |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Register optional kind permission | Valid slug, identical registration | malformed slug, conflicting registration | trusted application | N/A registry only | Node | omitted option retains refusal | unit: approvals test |
| Requester decides own pending request | opted-in human holds all slugs | absent opt-in, missing slug, agent/service, other tenant or active context | requester and non-owner, matching/conflicting tenants | service transaction | SQLite, DuckDB, PostgreSQL | all three verdicts, unchanged ordinary votes | shared approval suite: test / test:postgres |
| Self vote counts once and consumes | quorum one and two, append audit slug | duplicate vote, unmarked legacy self vote, expiry | authorized human / consumer | guarded UPDATE plus immutable event, caller rollback | SQLite, DuckDB, PostgreSQL | persisted marker defaults false/empty | shared approval suite: test / test:postgres |
| Existing atomicity and isolation | transitions commit together | insertion failure and caller rollback | existing shared-suite actors | same transaction handle | SQLite, DuckDB, PostgreSQL | no new write surface | full approvals test / test:postgres |
| Legacy event schema upgrade | add columns with false/empty defaults, preserve ordinary approval, new columns converge on rerun | unmarked self votes cannot gain authority | existing tenant records | public schema diff and MigrationTracker deployment transaction | SQLite, DuckDB, PostgreSQL | additive event schema | shared migration fixture: test / test:postgres |

Validation evidence is captured outside the worktree in /tmp/smrt-3766-evidence.

Known external limitation: [SDK #1395](https://github.com/happyvertical/sdk/issues/1395)
tracks DuckDB introspection retaining quotes around the existing `sequence` index
column, causing repeated recreation of that unchanged index. The upgrade fixture
checks convergence of the two new columns on every dialect, and full convergence
on SQLite/PostgreSQL. No adapter shim or index-contract change is included here.
