# Owner tool holds

`src/owner-approvals.ts` adapts the existing smrt-approvals ledger, rather than
introducing another approval model. `OwnerApprovalStore` is a trusted host storage
interface; its default SQLite adapter retains the original principal, permission
ceiling, arguments, tool and recovery context in a runtime system table. Decision
and consumption compare-and-set operations and their audit events remain in
`ApprovalService`. A revision hash pins the whole saved envelope. Application
migrations must include the canonical approval models. Unlinked envelopes from a
failed request are invisible and cannot execute.

`isApprovalOwner` reuses users' built-in system-role lookup and direct membership:
active user, active membership, exact tenant, canonical system owner role id.
Tenant-local roles called owner and inherited membership do not qualify.
Actor identity is snapshotted before asynchronous authorization, including the
decision tenant and the audit actor. Hosts may
inject another live owner check, but may never derive it from model output.
The adapter's synthetic ledger permission is minted only after this host check;
it is not a permission claim accepted from a client. The kind explicitly allows
an owner to approve their own assistant's request. Tenant approval policy may
only tighten the underlying kind; a quorum still pending never executes.

State: pending -> approved/denied/expired. Approved -> consumed (`executing`) ->
succeeded/failed. Consumption is durable before effects; crashes/partial effects
are at-most-once and require reconciliation, never automatic replay. Completion
cannot overwrite a previous result. Decisions remain audited even if execution or
transcript persistence fails. Polling waits read storage, so another process can
decide. Cancellation releases a waiter without deleting its durable hold.

## Test design and evidence

All new persistence behavior is exercised in-process on Node/SQLite. Other stores
are interfaces only; this adapter does not claim another dialect. The canonical
service retains its own SQLite, DuckDB and PostgreSQL transition suites.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Durable gate | Request then reopen | Exact original envelope | Malformed/executable data rejected | Server requester/tenant | SQLite envelope + ApprovalService transactions | Node/SQLite | Store interface | Integration | Package test |
| Owner/tenant authority | List/decide | Canonical live owner | Non-owner, foreign tenant, inactive membership/user | Human × resource tenant × active context | users collections + canonical decision transaction | Node/SQLite | No model decision entry | Integration | Package test |
| Single decision and execution | Concurrent decide/consume | One winner and audited actor | Second decision/consume/result rejected; restart cannot replay | Authorized owner and original caller | ApprovalService CAS + ledger, envelope result CAS | Node/SQLite | Partial/crashed effects require reconciliation | Integration | Package test |
| Expiry/cancellation | Clock reaches TTL; abort wait | Expired record; abort releases | Expired approval cannot revive/execute | Original tenant | Canonical expiry transaction | Node/SQLite | AbortSignal | Integration | Package test |
| Ledger atomicity | Canonical decision event insert fails | Decision and event commit together | Existing ApprovalService suites cover rollback | Canonical principal/tenant | Existing service transaction | Existing service dialect suites | No alternate ledger | Reused invariant | smrt-approvals tests (upstream evidence) |

`src/owner-approvals.test.ts` tests the adapter and authority; chat's route tests
exercise real authenticated holds and resumed execution. No providers or containers.

Legacy custom stores may advertise `supportsNonExpiring` and opt into the
constructor's `nonExpiring` option to preserve an established indefinite-hold
contract. The canonical SQLite store does not advertise this and rejects that
option before writing. Default TTL validation is unchanged. `wait` accepts an
optional fourth `{ settled: true }` argument to observe a host-executed hold
through approved/executing until a terminal result; ordinary waits still return
at the owner's decision. Tricia exercises the custom-store seam over its old
single-tenant rows rather than migrating history or creating a second ledger.

`maxInputChars` is a bounded constructor option (1 KB..16 MB, default 128 KB) for
hosts with a larger already-validated recovery payload. Tricia opts into 4 MB;
its nested template action travels as inert JSON rather than widening the shared
plain-data depth or accepting executable objects.
