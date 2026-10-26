# External agent measurements (#4336)

`ExternalAgentUsageRecorder` in core reuses `_smrt_ai_usage` rather than introducing
another ledger. It stores immutable sequence facts and deltas. `tags` contains only
the validated report and receipt. Existing primary-key and class/tenant indexes
serve sequence reads and bounded-by-session summary/event identity queries.
System bootstrap precedes caller transactions. Transactions and embedded write
queues cover predecessor validation, conflict arbitration, and persistence.

The caller authorizes a trusted full ownership binding before constructing the
recorder. Transport principals may report child workers, so actor authorization
belongs to the application; attribution is never inferred from that principal.
Only exclusive measurements are accepted. Inclusive parents must be converted by
an adapter with evidence, or withheld. Components may be subsets or additional
usage as explicitly declared; the service never derives total tokens by addition.
Unknown counters remain null, including a cumulative delta after an unknown
baseline or unknown previous counter. Cumulative resets require an explicit next
epoch; first/reset measurements require a verified zero origin to count the
snapshot as delta. Provider/model and measurement semantics cannot change within
a real native harness session. The initial contract supports one task/provider/model
per session; task or model switching within an existing main chat is unsupported
and fails closed. A new span requires a real fresh session with verified zero
origin, or unknown baseline reporting. Never invent session IDs or count an old
cumulative snapshot again as a new zero baseline.

No prompt, transcript, arbitrary tags, costs, or credentials enter the contract.
Provider-measured facts only: producer verification belongs to authenticated
adapters. The framework cannot authenticate provider output from a JSON object.
Native subscription AI billing excludes `operation = external-agent`. Default core list/summary queries also exclude external records; consumers
use the safe recorder summary for external usage. `duration = 0` is a required
legacy storage placeholder, never a measured duration. Empty summaries contain
unknown counters. `complete` means every supported counter has known deltas for
every report; per-counter `coverage` exposes known and unknown report counts. A
provider omitting cache/reasoning counters produces partial data.

Retention: external reports are durable replay evidence. `pruneAiUsage` excludes
this operation for both age and row limits. Explicit application deletion is an
administrative boundary: consumers must allocate a fresh session after deletion.

## Behavior-to-test matrix

All rows use fixture-only actors and real in-process SQLite and DuckDB through
`getTestDatabase`, at service integration level. No external API or runtime model
call occurs. Validation: `pnpm --filter @happyvertical/smrt-core exec vitest run
src/__tests__/external-agent-usage.test.ts` (minimal environment). PostgreSQL is a
required integrated gate because conflict targets are touched; the same suite's
optional PostgreSQL wrapper must run before release. No schema change; migration
N/A. SDK runtimes are Node >=26 and browser entry evaluation; dialects inherit
SQL adapter support.

| Behavior / reachable trigger | Positive | Negative/failure | Actor/context and executor |
| --- | --- | --- | --- |
| Explicit tenant/ownership binding, record and summary | Bound tenant session writes/reads | Other tenant/project/task/role denied; same session cannot be rebound | authenticated caller's scope, same transaction |
| Immutable report identity, retry/concurrency | Exact retry/concurrent same sequence returns receipt once | Changed same sequence or reused event at later sequence refused | two writers, insert arbiter |
| Ordering/reset | contiguous sequence; epoch+1 reset | gap, decreasing snapshot, invalid reset, reordered time | one stream transaction |
| Unknown and zero | zero remains zero; missing/null stays null | unknown baseline cannot fabricate delta | per-counter persisted delta |
| Components | explicit inclusive or exclusive cache/reasoning semantics preserved | components exceeding known inclusive total refused | provider fixture, normalization before DB |
| Open contract | optional parent/counters omitted | unknown version/fields, negative/fraction/unsafe/NaN, inclusive scope refused | untrusted JSON, no side effects |
| Atomic caller mutation | successful transaction persists receipt | outer rollback removes receipt; retry then succeeds | caller transaction handle |
| Billing separation | external records visible in safe summary | hosted AI billing excludes them | tenant subscription collection aggregate |

This is new behavior: base regression comparison N/A. Upstream failure is the DB
rollback case; provider calls are outside this service. No application ownership
lookup exists in core: application adapter tests must demonstrate authorization
before supplying the trusted binding.


## Worker evidence

Node 26.8.1, pnpm 11.25.0. `pnpm` on this host has a Node 24 shebang; commands
use Node 26 explicitly (`node /Users/will/.local/bin/pnpm`) without changing the
repository toolchain. Every validation child has only PATH and HOME; provider
credentials are absent. Installation, dependency builds, core build, core
production/test typecheck, focused 74 core tests, and eight subscription meter
tests passed. HaveConfig's portable structured fixture normalized via the built
core root export. `/tmp/work-419-packs/happyvertical-smrt-core-0.57.30.tgz` is the
uncommitted consumer-proof package; final adoption requires a published family
version. Integrated root validation/review and isolated PostgreSQL lane belong
to the foreman and remain required before shipping.
