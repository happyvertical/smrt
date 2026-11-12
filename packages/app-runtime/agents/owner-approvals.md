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
## Non-thread tool continuations

`OwnerApprovalContinuations` reuses this authority and its canonical ledger. Its
`capture(principal, work)` takes a frozen original user/tenant, permission ceiling
and tool allow-list. `adapter(executor, consumption)` decorates native tool holds
with a separate `continuation` envelope; it does not alter args or the tool's own
context fingerprint. Executors are registered by trusted host code, never a
client-supplied module or callback. Native tools use `executor` consumption; generic
model tools use `continuation` consumption. Exactly one consumer wins the ledger
CAS. The executor must re-resolve live permissions and intersect the saved ceiling.

`decide(owner,id,approve)` authorizes the live owner, records the decision and
resumes the saved call. `resume(owner,id)` recovers an approved but unconsumed
call after restart. `outcome(requester,id)` reveals only that requester's tenant
record and recorded result. Chat's existing owner list/decision route dispatches
these records without requiring a thread. MCP hosts provide a scoped outcome tool.
Denied/expired calls never execute. Already executing calls never replay: a crash
after consumption remains an explicit unknown outcome, requiring reconciliation.
This is at-most-once dispatch, not a claim of transactional exactly-once external
effects. Hosts must not silently retry such effects.

Reuse audit: MCP project reviews for app-runtime/chat/core/template/Svelte, intent
index, and `rg` continuation/resume/approval/execute across core, runtime, approvals,
chat, smrt-ui and smrt-svelte found the existing authority, ApprovalService, plain
snapshot validator and assistant continuation store. The last is a short-lived
browser-turn transcript and cannot dispatch durable non-thread tool calls. This
extends `owner-approvals.ts`; no new store/model/component/file is introduced.
SQLite tests cover reopened authority, original args/ceiling, concurrent resume,
native single consumption, deny/expiry, foreign requester and repeated decisions.

## Continuations with legacy stores and settled waits

The D1 second-rebase audit keeps `supportsNonExpiring`, `nonExpiring` and
`maxInputChars` on the same authority used by continuation adapters. An adapter
does not construct another authority or override its TTL/input policy. A custom
store used for continuations must preserve the full inert OwnerApproval envelope,
including its continuation binding; Tricia continues to use its own action
executor and installed row mapping unchanged. No legacy schema migration is added.

| Invariant | Trigger / positive | Failure / control | Actor / executor | Runtime / edge / level | Validation |
| --- | --- | --- | --- | --- | --- |
| Legacy continuation | Non-expiring SQL fixture reopened after 30 days; 140 KB review under explicit 4 MB budget; original args and one result | Foreign tenant and repeat resume refused; canonical store still rejects indefinite mode | Original owner/tenant, test-local OwnerApprovalStore with SQLite CAS | Node/SQLite, custom host store seam, integration | app-runtime full test |
| Settled observation | Separate authority waits through approved and executing to recorded result in both consumption modes | Ordinary wait still returns approved; settled never grants permission or executes | Original owner; native executor or continuation owns consume/complete | Node/SQLite, public wait seam, integration | app-runtime full test |

Reuse: repeated MCP package review/context and name/purpose searches for
continuation, non-expiring storage, settled wait and approval observation across
runtime/chat/core/Svelte/UI/app-shell. Tests extend owner-approvals.test.ts with an
inline SQLite legacy-store fixture; no production helper, store or model is added.

A trusted local MCP adapter may capture `principal.clientName` from the owner's
credential label. The continuation adapter prefixes that label onto the saved
approval summary without changing native args/context fingerprints or consumption.
Token verification exposes non-enumerable `clientName`/`tokenId` provenance to the
host; serialized principals and their permission snapshots retain their existing
shape. Client-supplied MCP names never establish identity or approval authority.

Concurrent recovery and owner-decision resumes share an in-flight native executor
dispatch within one continuation adapter. The native executor still owns durable
consumption; generic continuation dispatch retains its canonical consumption CAS.

## PostgreSQL envelope adapter

`createOwnerApprovalStore(db, now?)` is the portable name of the existing
canonical ApprovalService adapter. `createSqliteOwnerApprovalStore` remains an
alias for current hosts. SQLite and PostgreSQL/PGlite are supported; other
engines refuse. PostgreSQL hold, tenant and gate IDs are native UUIDs. The host
system table is provisioned under core's existing serialized system-bootstrap
lock; application approval tables still require ordinary migrations.
`pnpm --filter @happyvertical/smrt-app-runtime test:pglite` reruns this package's
owner-approval/continuation suite on in-process PostgreSQL, including a database
close/reopen, single consumption, actor revalidation and results. No hosted
credential or external-effects exactly-once guarantee is implied.

Legacy PostgreSQL envelopes with TEXT identities fail with `OWNER_APPROVAL_MIGRATION_REQUIRED`; validate their values and migrate the system table to UUID before serving. Runtime never rewrites those identities.
