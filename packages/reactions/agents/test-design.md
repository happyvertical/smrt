# #3837 behavior-to-test design
Feature addition (base regression N/A: no reactions/polls API on base). High risk: tenant and trusted participation boundary. Owner packages/reactions only; foreman owns root graph/lock.

|Behavior/invariant|Reachable trigger|Positive|Negative/failure|Actor/context|Executor/transaction|Runtime|External edge|Level/command|
|---|---|---|---|---|---|---|---|---|
|Unique reactions and scoped tally|setReaction, retract, tally|repeated desired state; two actors/kinds|unknown kind; absent actor; denied record; foreign tenant|trusted user/profile × tenant target × active host allow/deny|atomic insert ON CONFLICT / delete on supplied transaction|SQLite PostgreSQL|entitlement missing/throw/denied fail closed|integration pnpm --filter @happyvertical/smrt-reactions test|
|Poll lifecycle|create, setClosed, vote|options/window/close/reopen|empty/duplicate options; invalid visibility/date; exact opens inclusive closes exclusive|authorized manage vs read/vote|row lock serializes close vs vote|same|host access denied/failure|integration same|
|One actor vote and immutable snapshot|vote|same option replay retains original; tally|different option rejected; snapshot object later mutated cannot rewrite|profile/user binding host; foreign tenant denied|poll row lock + unique index; retry after rollback|same|snapshot missing/invalid; eligibility hook failure|integration same|
|Shared ban/rate enforcement|react/vote|authorized mutation and quota reservation|ban/rate limit blocks, unknown policy fails closed|active/banned actor same tenant|ParticipationService.executeInTransaction uses mutation executor; rollback releases quota|same|exact shared comments contract|integration same|
|Svelte projections|ReactionBar/PollCard|callback and selected/results render|disabled/busy/errors suppress writes; no actor identity exposed|host-authorized projections only|N/A presentation no DB|Svelte 5 browser DOM|async callback failure visible|component tests + svelte-check|

Concurrency: explicit desired state uses unique index and conflict-safe insert; vote uses transaction-held poll row write before existing-vote read. Independent database connection race evidence required where backend supports it; no process-global locks. Schema only manifests, no DDL. Accepted reduced milestone: SQLite/PostgreSQL only; DuckDB factory rejection before opening/authorization/mutation has executable zero-side-effect tests. SDK #1452 blocks independent-adapter visibility and #3837 remains open. PGlite is outside the accepted supported set (missing optional peer; core getTestDatabase type excludes it).

## Accepted backend boundary and evidence

The parent approved a useful SQLite/PostgreSQL milestone, leaving #3837 open/blocked on SDK #1452. Runtime creation owns the connection from a mandatory allowlisted typed configuration. It rejects DuckDB/JSON/PGlite/unknown engines and adapter-shaped extra properties before opening. No arbitrary adapter injection, private casts, schema workaround or fake DuckDB support is present. SQLite independent sessions reacquire the complete runtime after adapter invalidation; PostgreSQL independent sessions use separate public pools.

Generated REST/MCP/CLI mutations are false on all three models (registry assertions). Package-private executor-bound WeakMap write authority (unique operation transaction only) guards direct collection/model save/delete; immutable poll options/vote evidence remain guarded at the canonical persisted-row boundary. Svelte callback tests cover selected state, withheld counts, disabled/pending actions and accessible async failure.

## Executable scenarios

- `reactions.test.ts`: desired reaction replay/retraction and scoped tallies; one actor vote/snapshot replay; direct collection save/create/delete authority; storage failure and quota rollback; exact poll/ban/rate window boundaries; missing/unknown/throwing policy inputs; actor/tenant/manage denials.
- SQLite contention launches independent Node processes with a start barrier. Every rejected operation must report SQLITE_BUSY, committed rows stay at most one, and a fresh-runtime retry/replay yields exactly one row. A separate same-process test holds a public transaction write lock, observes BUSY and an invalidated read on a second runtime, closes/recreates through the uncached factory, and votes/replays successfully.
- PostgreSQL contenders use independent uncached pools and require a committed winner. Each test owns a separate schema namespace selected by its connection URL; the schema owner drops it only after every runtime is closed. Manifest utilities create application tables; no handwritten table definitions are used.
- Registry tests assert API/CLI/MCP false for Reaction, Poll and PollVote. Unsupported backends and adapter-shaped configurations fail before connection/authorization and leave their target directory empty.
- `svelte/components.test.ts`: selected reaction state/callback, pending/error handling, poll aggregate counts, withheld counts and disabled/closed/already-voted submission guards.

Package validation commands: `pnpm --filter @happyvertical/smrt-reactions test`, `typecheck`, `check`, `build`, `test:postgres`; root review/integration belongs to the train coordinator. No containers are started by this package's worker.

## Browser/server boundary

`/server` owns the SQL connection factory and participation runtime; the root owns only models, collections and types. The existing browser bundle gate attributes zero new server imports to reactions; the known upstream tenancy boundary is inherited. Executor-keyed WeakMap authority is isomorphic and scoped only to a unique transaction executor, revoked in finally. Tests ensure root adapters and unrelated concurrent transactions cannot inherit permission, including across await/failure, and server/root exports retain identical model constructors.
