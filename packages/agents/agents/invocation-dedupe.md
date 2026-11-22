# Durable invocation dedupe (#5525)

`processAgentInvocations()` runs workers delivered through the DispatchBus
`agent.invoke.*` signal. A dispatch row can be delivered more than once (an
operator `retry()`, a lease reclaim after a crash, two processors holding the
same row), and a worker does paid work. The ledger `_smrt_agent_invocations`
(`AgentInvocation`, `src/agent-invocation.ts`) makes one dispatch row start
paid work at most once.

## Contract

- **Key.** One ledger row per dispatch row: a unique index on `dispatch_id`
  alone. The `_smrt_dispatch.id` is globally unique, so no tenant is in the key
  and a global (NULL-tenant) row processed under several tenant contexts still
  reserves once. `tenant_id` is the delegation envelope's tenant, kept for
  access control only.
- **Reservation before paid work.** `INSERT ... ON CONFLICT (dispatch_id) DO
  NOTHING RETURNING id` on the base `db` handle, awaited before
  `executeAsPrincipal` opens the principal context (which may open an RLS
  transaction). A lost worker transaction cannot erase the reservation.
- **Order after the worker returns.** Record the completion
  (`state = 'result_recorded'`, `result_json`), then publish the
  `agent.completed` dispatch with `metadata.invocationId = <dispatch id>` inside
  the envelope's tenant context, then `state = 'published'`. The recording
  happens after `executeAsPrincipal` has returned, so a result is never recorded
  for a principal transaction that failed to commit.
- **Redelivery never reruns the worker.**
  - `published`: skipped.
  - `result_recorded`: the recorded completion is republished, then marked
    `published`.
  - `reserved` (no result): moved to `uncertain`; an `ok: false` completion with
    `error: 'AGENT_INVOCATION_UNCERTAIN'` is published so the orchestrator stops
    waiting. `uncertain` rows republish that completion on further
    redeliveries.
  - The reservation owner may still record a late result over `uncertain`; its
    completion then supersedes the uncertain one.
- **Surfacing.** `surfaceAgentCompletions()` returns one completion per
  `metadata.invocationId`: the newest (on a timestamp tie a concrete outcome
  beats `AGENT_INVOCATION_UNCERTAIN`). Completions without an invocation id
  (inline transport, older rows) are each returned, as before.
- **Fail closed.** `processAgentInvocations()` opens the ledger before it
  subscribes or claims. A missing `db`, or a missing table, throws
  `AgentInvocationLedgerMissingError` (`code:
  'AGENT_INVOCATION_LEDGER_MISSING'`). Runtime only checks that the table
  exists; schema comes from `smrt db:migrate`.
- **Provider idempotency.** The worker receives the dispatch id as
  `WorkerInvocation.invocationId`; pass it as the provider's idempotency key
  where the provider client supports one. It narrows, but does not replace,
  the `uncertain` state: the `@happyvertical/ai` client has no idempotency-key
  option today.

## Operator reconciliation

`uncertain` means the worker may or may not have done its paid work. Nothing
reruns it automatically. Inspect `_smrt_agent_invocations` (`state`,
`attempts_seen`, `correlation_id`, `agent_class`, `tenant_id`) together with the
provider's own records, and re-invoke deliberately if the work did not happen.
The ledger is internal (`api`/`cli`/`mcp` off); `AgentInvocationCollection` is
exported for host tooling.

A failure before the worker starts (for example the permission lookup inside
`executeAsPrincipal`) also leaves a reservation with no result, so its
redelivery is `uncertain` too. This is deliberate: the ledger cannot tell that
case apart from a crash during paid work.

## Upgrade

Run `smrt db:migrate` (the agents manifest adds `_smrt_agent_invocations`)
before starting any process that calls `processAgentInvocations()`.
`Agent.handleDispatch` subclasses are not deduplicated by this ledger; they
must stay idempotent on `metadata.id`.

## Tests

`src/invoke-agent-dedupe.test.ts` (SQLite; PGlite via `pnpm test:pglite`) and
`src/invoke-agent-dedupe-postgres.optional.test.ts` (in `test:postgres`).
