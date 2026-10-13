# #3767 published review host

Risk: high (authenticated review and feedback disclosure boundary). The factory
accepts an already session-scoped service and trusted host adapters, never scope
from callback payloads. Assignment and upload authorization remain host-owned.

| Behavior / trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Test / command |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Published host list/load | aggregate all review pages, unwrap generation | repeated cursor, stale generation, read denial | authenticated reviewer, revoked/foreign scope | public service owning transactions | Node SQLite/PostgreSQL | pagination, absent generation | host contracts plus existing real review lanes: test/test:postgres |
| Preview / decision / apply / edit / split | stable intention and action/plan CAS, repeated prepare preserves review, delegate current authority | malformed selection, duplicate retry, stale attempt | current reviewer only | owning service transaction | SQLite/PostgreSQL | host upload/evidence/assignment adapters | test/test:postgres/test:e2e |
| Optional feedback retrieval denied | generation without examples | unknown failure propagates; initial allow followed by final retrieval denial and revocation after selection stay closed | submitter vs reviewer | feedback receiving transaction | SQLite/PostgreSQL | denial-only degradation | feedback shared suite: test/test:postgres |
| Proposal limits | valid documented bounds | maxCandidates >20 rejected on service construction | trusted deployment | N/A validation only | Node | malformed/missing limits | unit/service test |
| Host adoption docs | receive then analyze, retention ordering, exact args | invalid values documented | deployment author | N/A prose | all supported | exported generation wrapper | typecheck/build |

Evidence directory: /tmp/smrt-3767-evidence. Existing browser suite exercises
transport and real service authority; new factory contract tests exercise wiring.
