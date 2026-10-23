# @happyvertical/smrt-reactions

Generic reactions and lightweight multi-option polls on arbitrary tenant-owned records. The package root exports models, collections and types without this package’s Node runtime; the Node-owned runtime lives at `/server`. This is not a governance ballot, secret election, quorum or legal audit system.

`Reaction`, `Poll`, `PollVote` and their collections publish s-m-r-t manifests.

This release is a **SQLite/PostgreSQL milestone**. DuckDB is refused before any connection or mutation, pending [SDK #1452](https://github.com/happyvertical/sdk/issues/1452): independent public DuckDB adapters do not share committed visibility. PGlite, JSON and unknown backends are also refused. Full issue #3837 remains open until the DuckDB guarantee is implemented and verified upstream. Apply the host's normal manifest migrations before using services. The factory always opens an uncached owned adapter (`cache: false`); `cache: true` and arbitrary executor-shaped configurations are rejected. Generated API/CLI/MCP mutations are disabled; the services enforce the authorization and transaction boundary.

```ts
import { ParticipationRuntime } from '@happyvertical/smrt-reactions/server';
const options = {
  database: { type: 'postgres' as const, url: databaseUrl },
  actor: { tenantId, userId, profileId },
  authorizeRecord: async (access) => hostRecordAccess(access),
  participation: { authorize: async (request) => hostParticipation(request) },
};
const runtime = await ParticipationRuntime.create(options);
// Apply manifest migrations to runtime.database before use.
const { reactions, polls } = runtime;
await reactions.setReaction('app:Article', articleId, 'like', true);
await reactions.retract('app:Article', articleId, 'like');
const poll = await polls.create({
  recordType: 'app:Article', recordId: articleId, question: 'Next topic?',
  options: [{ id: 'parks', label: 'Parks' }, { id: 'roads', label: 'Roads' }],
  visibility: 'after_vote', anonymousTally: true,
});
await polls.vote(poll.id!, 'parks');
const projection = await polls.results(poll.id!);
```

Hosts authenticate the actor and verify the profile belongs to that user and tenant. `authorizeRecord` must check the actor's active context, target ownership and requested action (`read`, `react`, `vote`, `manage`). Missing callbacks/actor IDs and rejected or throwing callbacks fail closed. Never construct these options from untrusted request actor fields. Hosts connect subscriptions/identity and record-date eligibility through the **exact** `ParticipationAuthorizer` from `@happyvertical/smrt-comments/participation`. Votes require a nonempty JSON-serializable decision `snapshot`, such as `{ planKey, eligibilityRecordDate }`; services serialize this at first write. No identity, subscriptions, Anytown, or membership policy is duplicated here.

The shared `ParticipationService` owns policies, bans and fixed-window quotas. Configure those using the comments package's public collections. New reactions/votes reserve quota in the same transaction as persistence; failures roll both back. Replays recheck permission and bans but preserve existing vote evidence and avoid charging new quota. Retractions do not consume quota. A desired reaction state is idempotent; each `(tenant, target type, target ID, profile, kind)` is unique. Supported kinds are exported as `REACTION_KINDS`. Concurrent writes are arbitrated by database uniqueness; transaction conflicts may be retried by the host. When SQLite reports a connection invalidated after `SQLITE_BUSY`, acquire a fresh runtime and retry the entire operation. No process-local lock is used.

Poll options are fixed at creation (2–50 unique IDs). A profile can vote once per poll: an identical retry succeeds, a different choice fails, and evidence never changes through the service. Poll row writes serialize vote and administrative close/reopen. Opening is inclusive, closing exclusive. Reopening clears only manual closure and never bypasses the configured time window. A retained identical vote may replay after closure. `visibility` is `always`, `after_vote`, or `after_close`; hidden results omit both counts and total. Every projection omits voter IDs and snapshots; `anonymousTally` records the host's presentation intent, and this package always returns aggregates even when false. Direct model/collection create, save and delete are refused outside the package service write scope. Authority is bound to the exact unique transaction executor and removed when that operation ends; shared root adapters are never authorized. The exported readonly `runtime.database` exposes the owned adapter for host migrations and administrative database access. Services own transactions; arbitrary adapter injection and caller-owned transaction composition are intentionally unavailable until the SQL contract can attest supported executor identity.

`ReactionBar` and `PollCard` from `/svelte` take authorized tally/projection props and async callbacks. Refresh props after mutation and remount on actor/tenant/record changes. Components perform no fetch or authorization. Pending and disabled actions cannot submit; callback failures show an accessible error.

Validation: `pnpm --filter @happyvertical/smrt-reactions test`, `typecheck`, `check`, `build`. Tests exercise SQLite and PostgreSQL when `SMRT_TEST_POSTGRES_URL` is supplied (`test:postgres` uses the repository CI launcher). See [test design](agents/test-design.md).
