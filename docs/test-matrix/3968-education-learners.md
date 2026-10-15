# #3968 learner identity and enrollment progress

High risk: authorization and tenant isolation. Generated operations are closed.
The trusted host authenticates the context and decides guardian relationship
semantics. Database access and direct model writes are trusted server APIs.

| Behavior / invariant | Reachable trigger; positive / negative | Actor / context | Executor / transaction | Runtime / dialect | External edge / level | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| Learner identity | Provision linked User/Profile with active membership; missing/mismatched identity rejected | Exact tenant; no ancestor inheritance | Actual model saves on supplied executor | Node SQLite/PostgreSQL | Missing references; integration | education test, test:postgres |
| Resource authorization | Read own progress and start own lesson; sibling/cross-family/context spoof denied | Learner × own/sibling/other family × matching/missing/wrong context | Service transaction and read executor | Node SQLite/PostgreSQL | Host denial/exception and forged relationship fail closed; integration | education test, test:postgres |
| Guardian authority | Related guardian with host grant may plan/read; unlinked or host-denied actor rejected | Exact family tenant and directed ProfileRelationship | Same executor for identities and resource | Node SQLite/PostgreSQL | Relationship type/time semantics are host-owned; integration | education test, test:postgres |
| Enrollment consistency | Matching curriculum/learner/course and lesson allowed; swapped learner/course lesson rejected | Authorized owner; hostile persisted links | Model checks + owning service revalidation | Node SQLite/PostgreSQL | Invalid enum/input rejected; integration | education test, test:postgres |
| Progress identity/history | Repeat/concurrent starts, both across root transactions and within one callback transaction, return one row; new curriculum enrollment creates new history without resetting old state | Same authorized learner | One executor; database uniqueness and enrollment lock | Node SQLite/PostgreSQL | Retry/concurrency; integration | education test, test:postgres |
| Atomicity | Composite workflow commits together; thrown callback rolls back all writes and retry succeeds | Authorized guardian/learner | Service transaction-bound collections and catalog reads | Node SQLite/PostgreSQL | Callback failure; integration | education test, test:postgres |
| Unscored versus zero | Null score roundtrips independently of zero; invalid numbers rejected; learner cannot supply grade/completion fields | Trusted model writer versus learner service | Actual persistence | Node SQLite/PostgreSQL | Unknown status/malformed settings; integration | education test, test:postgres |
| Closed surfaces and recipe | Manifest closes API/MCP/CLI/AI and recipe names real models | Generated caller | N/A metadata only | Node | Generator contract; unit | education test, build |

Full learner schemas require catalog children and identity tables. Existing core
DuckDB DDL rejects child ON UPDATE CASCADE and Tenant self references; no full
learner workflow support is claimed on DuckDB. Existing reachable Course-only
DuckDB regression remains part of the full package suite. Browser/UI N/A: no
UI shipped. Bug-base comparison N/A: new feature, no previous learner API.

Storage conflict keys are tenant-prefixed, unlike the issue's logical tuples.
Parent ownership is immutable and save/service checks require that exact tenant,
so logical enrollment curriculum/course and progress enrollment/lesson uniqueness
is unchanged. Duplicate raw inserts are rejected by native database constraints. A stored
other-tenant progress row cannot reserve the valid owner's logical key; the
valid start succeeds without altering the hostile row. Same-parent cross-tenant
model creation is rejected.
