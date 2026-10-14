# Idempotent comment creation (#3941)

`CommentService.create({...input, idempotencyKey})` returns a `Comment`, including
its server-generated UUID. Keys are optional, trimmed nonempty strings of at most
200 characters, unique within a tenant. Omitted keys retain the original create
behavior. The service allowlists input: identity, slug, context, executor and
requestDigest cannot be supplied by the caller.

Valid UUID tenant/author identities use lowercase for equality, arbitration and
digest comparisons. Authorization, storage and listing preserve the trusted actor
context spelling, including existing SQLite rows; parent record keys remain exact.
The trusted actor and record authorization run before every attempt, including
replays. A key binds the actual author, qualified parent, exact body and sorted,
deduplicated validated mentions. Reusing a key with different bound content throws
`CommentIdempotencyError` with code `COMMENT_REQUEST_CONFLICT`. Replays return the
original unchanged comment. A retained receipt referring to a missing or modified
comment throws `COMMENT_REQUEST_UNAVAILABLE`, never recreates it.

The service reuses core `runOnce` for atomic arbitration. Its fixed internal actor
`smrt-comments.create:v1` is only an arbitration namespace: different authenticated
authors racing the same tenant/key must contend together. The actual author is
bound in the separate immutable request digest. Claim insertion uses core's
conflict-safe SQL; comment insertion uses the callback's executor and remains
insert-only with a random server UUID. Nullable key/digest fields on Comment retain
the binding after normal generic claim retention. Existing rows need no key.

The caller's DB must support transactions for keyed creates. Nested transaction
support follows the database adapter: unsupported nested transactions fail before
work, rather than silently widening the supplied executor. Hosts needing atomic
comment/notification rollback compose the service and notification adapter with
the same outer transaction handle. Notification delivery happens after comment
arbitration, including on identical retries. The default messages adapter's stable
comment sourceRef deduplicates delivered mentions and retries missing delivery.
Arbitrary adapters must provide their own replay safety; no exactly-once external
delivery is promised. Without an outer transaction a delivery failure leaves the
comment saved, and retrying the same key is supported.

The service exposes no edit/delete lifecycle. Trusted model/collection bypasses
must preserve key/digest binding. Deleting both the comment and retained core
claim intentionally destroys retry history and is outside this contract. Do not
purge retry history while clients may still retry. Runtime does not create schema;
apply normal SMRT migrations before using keyed creates.

## Test-design contract

All rows use the authenticated author and explicit tenant context, a real supplied
DB executor, and SQLite/DuckDB/PostgreSQL unless noted. Commands are package `test`
and `test:postgres`; public TypeScript contract is also checked by `typecheck`.

| Invariant / reachable trigger | Positive | Negative / failure | Executor / edge / level |
| --- | --- | --- | --- |
| Optional keyed create and retry | Same key and normalized mentions return one UUID | Empty, oversized or nonstring keys rejected before mutation | Root DB, public input, integration |
| Immutable tenant/request binding | Different tenants may reuse key | Changed author, parent, body or mentions conflicts | Authenticated actor, public service, integration |
| Authorization precedes replay | Authorized replay succeeds | Revoked record access or forged tenant/actor denied | Same DB, host authorization callback, integration |
| Concurrent arbitration | Simultaneous identical creates produce one row | Competing authors/payloads yield one winner, one typed conflict | Root DB; PostgreSQL outer transactions also remain usable, integration |
| Transaction affinity | Comment and claim use runOnce callback executor | Caller rollback removes comment, claim and composed notifications | PostgreSQL/SQLite supported nesting; DuckDB rejects unsupported nesting before writes, integration |
| Delivery recovery | Default notifications replay once per recipient | Partial adapter failure retains comment; same-key retry finishes missing notification | Real messages adapter and supplied DB; integration |
| Durable binding | Claim retention followed by retry finds original comment | Deleted/modified retained comment is unavailable | Trusted low-level mutation is test setup, integration |
| Persistence-option injection | Generated UUID remains server-owned | Injected id/slug/context/db/digest cannot replace another row | Existing three-dialect regression suite plus keyed case |

New additive API: baseline rejects `idempotencyKey` at the TypeScript boundary and
ignores it at runtime, creating duplicate rows. Record an executable baseline
retry failure before final evidence. Browser behavior is unchanged; existing Svelte
checks/tests remain required, and a new browser flow is N/A.
