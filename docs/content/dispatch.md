# DispatchBus: Inter-Agent Communication

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Asynchronous messaging system for agent-to-agent communication in the SMRT framework.

## Overview

The DispatchBus provides asynchronous messaging between agents. It enables loose coupling where agents like Suasor (marketing) can emit events that Fiscus (accounting) processes later.

```
┌─────────────┐     emit()      ┌──────────────────┐
│   Suasor    │ ───────────────▶│  _smrt_dispatch  │
│   Agent     │                 │     (pending)    │
└─────────────┘                 └────────┬─────────┘
                                         │
                                         │ process('fiscus')
                                         ▼
┌─────────────┐   handleDispatch()  ┌──────────────────┐
│   Fiscus    │ ◀───────────────────│  DispatchBus     │
│   Agent     │                     └──────────────────┘
└─────────────┘
```

## Features

- **Asynchronous Messaging**: Emit events for later processing
- **Persistent Subscriptions**: Survive application restarts
- **Wildcard Patterns**: Subscribe to event families (`campaign.*`)
- **Retry Mechanism**: Automatic retry for failed dispatches
- **Tracing Support**: Built-in metadata for observability
- **CLI Commands**: Manage dispatches from the command line
- **Agent Integration**: Built into the Agent base class

## Installation

The DispatchBus is included in `@happyvertical/smrt-core`:

```bash
npm install @happyvertical/smrt-core
```

## Quick Start

```typescript
import { createDispatchBus } from '@happyvertical/smrt-core';

// Create a dispatch bus
const bus = await createDispatchBus({
  db: { type: 'sqlite', url: 'app.db' }
});

// Subscribe to events (persistent - survives restarts)
await bus.subscribe({
  signalType: 'campaign.completed',
  subscriber: 'Fiscus',
  handler: 'handleCampaignRevenue'
});

// Emit an event
await bus.emit(
  'campaign.completed',
  { campaignId: 'camp-123', revenue: 5000.00 },
  { source: 'Suasor' }
);

// Process pending dispatches
await bus.process('Fiscus', async (payload, metadata) => {
  console.log(`Processing ${metadata.type} from ${metadata.source}`);
  // Handle the campaign completion...
});
```

## Two Types of Handlers

### In-Memory Handlers (Immediate)

Called synchronously when `emit()` is invoked. Useful for real-time reactions:

```typescript
// Register in-memory handler
bus.on('campaign.completed', async (payload, metadata) => {
  console.log(`Campaign ${payload.campaignId} completed!`);
  await sendSlackNotification(payload);
});

// Unregister when done
bus.off('campaign.completed', handler);
```

### Persistent Subscriptions (Processed Later)

Stored in database, processed when `process()` is called. Survives restarts:

```typescript
// Create persistent subscription
await bus.subscribe({
  signalType: 'campaign.*',    // Wildcard pattern
  subscriber: 'Fiscus',
  handler: 'handleCampaign'
});

// Later, process all pending dispatches
await bus.process('Fiscus', async (payload, metadata) => {
  // Handle each dispatch
});

// Remove subscription
await bus.unsubscribe('campaign.*', 'Fiscus');
```

## Wildcard Subscriptions

Subscribe to event families using wildcard patterns:

```typescript
// Match all campaign events
await bus.subscribe({ signalType: 'campaign.*', subscriber: 'Monitor' });

// Matches: campaign.started, campaign.paused, campaign.completed
// Does NOT match: campaign.summer.completed (single segment only)

// Match events with wildcards in the middle
await bus.subscribe({ signalType: 'agent.*.completed', subscriber: 'Logger' });

// Matches: agent.suasor.completed, agent.fiscus.completed
```

**Wildcard Rules:**
- Each `*` matches one or more characters other than `.`, so a wildcard never
  spans a segment boundary
- `campaign.*` matches `campaign.started` but NOT `campaign.summer.started`
- A wildcard may sit inside a segment: `invoice.v*` matches `invoice.v2` but
  NOT `invoice.v`
- Multiple wildcards allowed: `*.*.completed`
- Matching is case-sensitive on every database

`process()` handles the oldest routed rows first, and the `limit` and
`signalTypes` options apply to routed rows only, so newer or unrelated
dispatches never hide an older one.

## Dispatch Lifecycle

```
pending → processing → completed
                   ↘ failed → (retry) → pending
```

**Status Values:**
- `pending`: Waiting to be processed
- `processing`: Claimed under a lease and being handled
- `completed`: Successfully processed
- `failed`: Handler threw an error, or the bus failed the row with a
  framework reason (`[smrt:CODE] detail` in `last_error`)

## Leases and At-Least-Once Delivery

`process()` claims each row under a lease: a random `lease_token` and a
`claimed_until` expiry (`leaseMs`, default 5 minutes). While the handler
runs, the bus renews the lease every `leaseMs / 3`. If the process stops
(crash, deploy, a blocked event loop), the lease expires and the next
`process()` call of an eligible subscriber claims the row again. Delivery
is therefore **at-least-once**: handlers must be idempotent on
`metadata.id`, and may read `metadata.attempts`.

- `metadata.signal` is aborted when the attempt's lease is lost (another
  worker reclaimed the row, or it was retried or swept). The bus cannot
  stop a handler; one that ignores the signal may overlap the row's next
  delivery. The outcome of a lost attempt is not recorded.
- A holder whose lease expired but was not reclaimed still records its
  outcome.
- `maxAttempts` (default 5) bounds **claims** per row, not handler runs: a
  process that stops between a claim and its handler spends one. The budget
  is stamped on the row at its first claim. When an eligible subscriber
  polls, a row at its budget becomes `failed` with
  `[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] ...`.
- Lease statements must commit independently of the handler. `process()`
  refuses (`DISPATCH_LEASE_EXECUTOR_UNSAFE`) a PostgreSQL pool of fewer
  than two clients, a single PostgreSQL connection or a transaction handle;
  pass a dedicated handle as `leaseDb`. A pool a handler can exhaust delays
  renewals (each is bounded and retried); size the pool for it.
- Clock skew between processes must stay well below `leaseMs`.
- Pass `onStats` to `process()` to receive `DispatchProcessStats`
  (claimed, completed, failed, leaseLost, settleErrors, renewErrors,
  malformed, exhausted, scanRejects, timedOut, longLeases).
- **No execution deadline by default.** A hung handler keeps renewing its
  lease; once an attempt runs longer than 3x `leaseMs` the bus logs
  `dispatch.long_lease` once and counts `longLeases`. Opt in with
  `maxExecutionMs` (bus option or per `process()` call, at least
  `leaseMs`): at the deadline the bus stops renewing, aborts
  `metadata.signal` (`DISPATCH_EXECUTION_TIMEOUT`), clears the row's lease
  (`[smrt:DISPATCH_EXECUTION_TIMEOUT] ...`) and moves on; a later call
  reclaims the row. JavaScript cannot stop the handler, so one that ignores
  the signal may overlap the redelivery.
- `process({ phases: 'pending' })` claims pending rows only and leaves
  every leased row alone; `previewProcess(subscriber)` returns what
  `process()` would claim, with each row's phase, without writing.

### Maintenance

`process()` never fails a row for being abandoned. `bus.maintain()` and the
retention `dispatch` task (`smrt db:prune`, `runRetentionSweep`) fail a
`processing` row whose lease expired more than `orphanedLeaseAfterMs`
(`DispatchRetentionPolicy.orphanedLeaseAfterDays`, default 1 day) ago with
`[smrt:DISPATCH_LEASE_ORPHANED]`, **only when no subscription can route
it**. Any subscription row whose pattern matches counts, enabled or
disabled (a disabled subscription is a paused route); a targeted row needs
a subscription of its target, an untargeted row a `compete` subscription.
A routed row waits for its subscriber, which reclaims it under its claim
budget. Run maintenance (or `smrt db:prune`) at least daily: without a
polling processor or maintenance there is no time bound on an abandoned
row.

`bus.maintain({ release })` returns leases to `pending` with their
attempt count kept: `'expired'`, `'afterDrain'` (every lease, live or
expired; only once every worker of this release has stopped) or
`'legacy'` (rows an older core left `processing` without a lease). The CLI
form is `smrt dispatch:release-leases`. Both accept `dryRun`.

Maintenance is tenant-exact: under an active tenant it touches only that
tenant's rows, routed only by that tenant's subscriptions, and never global
rows. With tenancy on and no tenant it touches global rows only; with
tenancy off (and in retention) every row, each tenant row routed only by
its own tenant's subscriptions. A global row may be routed by any tenant's
subscription; that one cross-tenant read is named in code
(`DISPATCH_ORPHAN_ROUTE_CHECK`).

`smrt doctor --db` reports leased `processing` rows, expired and
long-held leases, `processing` rows without a lease, and rows no
subscription routes.

```typescript
await bus.process('Fiscus', async (payload, metadata) => {
  // Idempotent on metadata.id; stop early when the lease is lost.
  if (await alreadyInvoiced(metadata.id)) return;
  await createInvoice(payload, { signal: metadata.signal });
}, { onStats: (stats) => log.info('dispatch', stats) });
```

Framework reasons are exported: `DISPATCH_FAILURE_CODES` and
`parseDispatchFailureReason(lastError)`. Handler error text that starts
with `[smrt:` is stored as `handler: ...` and never parses as one.

## Upgrading to the dispatch lease (schema 1.22.0)

**Drain first. There is no rolling deploy.** Older processes write dispatch
rows without the lease token and would overwrite a live lease.

1. Stop every process running an older dispatch bus: workers, and anything
   calling `retry()`, `cleanup()` or `DispatchCollection.update()`.
2. Deploy the agents invocation dedupe release and run its migration
   **before** enabling this release. Until that release is deployed, do
   not enable the lease anywhere: a redelivered `agent.invoke` would run
   paid work twice. There is no option that turns the lease off.
3. Start the new processes. Bootstrap adds the nullable columns and the
   `(status, created_at, id)`, `(status, claimed_until, id)` and
   `(status, updated_at, id)` indexes. On a large PostgreSQL
   `_smrt_dispatch`, pre-create those indexes `CONCURRENTLY` under the same
   names (`idx_smrt_dispatch_status_created_id`,
   `idx_smrt_dispatch_status_claimed_id`,
   `idx_smrt_dispatch_status_updated_id`) to avoid blocking writes.

Rows an older process left `processing` carry no lease and are not
reclaimed automatically; `smrt doctor --db` counts them. Once every older
process is stopped, either return them to `pending` with
`smrt dispatch:release-leases --legacy`, or opt in to legacy reclaim with
`legacyLeaseGraceMs` (a row is then claimed once its `updated_at` is that
much older than the call start; a row whose `updated_at` cannot be read is
left for the release command). Never set `legacyLeaseGraceMs` while an
older process may still be running such a row. Rows whose `attempts`
already reached the budget become `failed` with
`[smrt:DISPATCH_ATTEMPTS_EXHAUSTED]` when polled; revive them with
`retry({ resetAttempts: true })` or `smrt dispatch:retry --reset-attempts`.

`smrt dispatch:process` (the CLI's logging handler) no longer reclaims
expired leases unless `--include-expired` is passed, and
`smrt dispatch:retry` without `--max-attempts` retries rows below their own
claim budget (5 by default) instead of below 3. `smrt db:prune` now also
fails abandoned leases no subscription routes (reported as
`details.orphaned`).

Rollback: stop the new processes, run
`smrt dispatch:release-leases --after-drain` (or wait `leaseMs` and run it
without the flag), confirm `smrt doctor --db` shows **zero leased
processing rows**, then start older code. Older code ignores the extra
columns, and `[smrt:...]` failed rows are plain `failed` rows to it.

## Retry Failed Dispatches

```typescript
// Retry failed rows whose claim budget is not spent
const count = await bus.retry();
console.log(`Reset ${count} dispatches for retry`);

// Revive rows whose budget is spent (attempts back to 0)
await bus.retry({ resetAttempts: true });

// Then process again
await bus.process('Fiscus', handler);
```

A retried row keeps its attempt count unless `resetAttempts` is passed.

## Cleanup Old Dispatches

```typescript
// Delete completed dispatches older than 30 days
const result = await bus.cleanup({
  completedOlderThanDays: 30,
  failedOlderThanDays: 90
});
console.log(`Deleted ${result.completedDeleted} completed, ${result.failedDeleted} failed`);
```

## Query Dispatches

```typescript
// List all pending dispatches
const pending = await bus.list({ status: 'pending' });

// Filter by source
const fromSuasor = await bus.list({
  status: 'completed',
  source: 'Suasor'
});

// Filter by type
const campaigns = await bus.list({ type: 'campaign.completed' });

// Get single dispatch by ID
const dispatch = await bus.get('dispatch-uuid');
```

## Agent Integration

Agents have built-in dispatch support:

```typescript
import { Agent } from '@happyvertical/smrt-agents';

class Fiscus extends Agent {
  // Override to handle dispatches
  async handleDispatch(payload: unknown, metadata: DispatchMetadata): Promise<void> {
    if (metadata.type === 'campaign.completed') {
      await this.recordRevenue(payload);
    }
  }

  async processIncomingDispatches(): Promise<void> {
    // Get the dispatch bus (lazy-created)
    const bus = await this.getDispatch();

    // Subscribe to relevant events
    await bus.subscribe({
      signalType: 'campaign.*',
      subscriber: this.constructor.name
    });

    // Process with the built-in handler
    await this.processDispatches();
  }
}
```

**Agent Methods:**
- `getDispatch()`: Get or create DispatchBus instance
- `handleDispatch(payload, metadata)`: Override to handle dispatches
- `processDispatches(options)`: Process pending dispatches for this agent

## Metadata and Tracing

Include metadata for observability:

```typescript
await bus.emit(
  'order.placed',
  { orderId: 'ord-123', total: 99.99 },
  {
    source: 'Checkout',
    sourceId: 'checkout-instance-1',
    metadata: {
      traceId: 'trace-abc123',
      spanId: 'span-xyz789',
      environment: 'production'
    }
  }
);

// Access metadata in handler
await bus.process('Billing', async (payload, metadata) => {
  console.log(`Trace: ${metadata.metadata.traceId}`);
  console.log(`Source: ${metadata.source} (${metadata.sourceId})`);
});
```

## CLI Commands

```bash
# List dispatches
smrt dispatch:list
smrt dispatch:list --status pending
smrt dispatch:list --source Suasor
smrt dispatch:list --status failed --reason DISPATCH_ATTEMPTS_EXHAUSTED

# Preview, then process, for a subscriber. --dry runs the bus's own
# candidate query and prints each row's phase. The live command processes
# pending rows only; --include-expired also reclaims expired leases.
smrt dispatch:process --subscriber Fiscus --dry
smrt dispatch:process --subscriber Fiscus
smrt dispatch:process --subscriber Fiscus --include-expired

# Retry failed dispatches below their claim budget (5 unless configured);
# --reset-attempts revives rows whose budget is spent
smrt dispatch:retry
smrt dispatch:retry --reset-attempts --type invoice.created

# Return leases to pending (attempts kept): expired leases by default,
# every lease after all workers stopped, or rows an older core left behind
smrt dispatch:release-leases --dry
smrt dispatch:release-leases
smrt dispatch:release-leases --after-drain
smrt dispatch:release-leases --legacy

# Cleanup old dispatches (--dry counts what the same cutoffs would delete)
smrt dispatch:cleanup --completed-older-than 30
smrt dispatch:cleanup --completed-older-than 30 --failed-older-than 7 --dry

# Manage subscriptions
smrt dispatch:subscriptions
smrt dispatch:subscriptions --subscriber Fiscus
smrt dispatch:subscribe --signal-type campaign.* --subscriber Fiscus
smrt dispatch:unsubscribe --signal-type campaign.* --subscriber Fiscus
```

## Database Tables

The dispatch system uses two system tables:

### `_smrt_dispatch`

Stores dispatch messages:

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Unique identifier |
| type | TEXT | Signal type (e.g., 'campaign.completed') |
| source | TEXT | Emitting agent name |
| source_id | TEXT | Optional instance identifier |
| payload | TEXT | JSON-encoded payload |
| status | TEXT | pending, processing, completed, failed |
| attempts | INTEGER | Number of claims |
| last_error | TEXT | Handler error, or a framework reason `[smrt:CODE] detail` |
| processed_at | DATETIME | When processing completed |
| processed_by | TEXT | Subscriber that processed |
| metadata | TEXT | JSON-encoded trace metadata |
| lease_token | TEXT | Token of the current (or last) claim |
| claimed_until | TIMESTAMP | Lease expiry while `processing` |
| max_attempts | INTEGER | Claim budget, stamped at the first claim |

### `_smrt_dispatch_subscriptions`

Stores persistent subscriptions:

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Unique identifier |
| signal_type | TEXT | Pattern to match (supports wildcards) |
| subscriber | TEXT | Agent name |
| handler | TEXT | Method name to invoke |
| enabled | INTEGER | 1 = active, 0 = disabled |

## API Reference

### createDispatchBus(options)

Creates a new DispatchBus instance.

```typescript
const bus = await createDispatchBus({
  db: { type: 'sqlite', url: 'app.db' }
  // or: db: existingDatabaseInterface
});
```

### bus.emit(type, payload, options)

Emit a dispatch message.

```typescript
await bus.emit(
  'campaign.completed',
  { campaignId: '123', revenue: 5000 },
  {
    source: 'Suasor',          // Required: emitting agent
    sourceId: 'instance-1',    // Optional: instance identifier
    metadata: { traceId: 'x' } // Optional: trace metadata
  }
);
```

### bus.subscribe(options)

Create a persistent subscription.

```typescript
await bus.subscribe({
  signalType: 'campaign.*',     // Pattern (supports wildcards)
  subscriber: 'Fiscus',         // Agent name
  handler: 'handleCampaign',    // Optional: method name
  enabled: true                 // Optional: default true
});
```

### bus.process(subscriber, handler, options)

Process pending dispatches for a subscriber.

```typescript
const count = await bus.process(
  'Fiscus',
  async (payload, metadata) => {
    // Handle dispatch
  },
  {
    limit: 100,                          // Optional: max rows claimed (default 100; negative = no limit)
    signalTypes: ['campaign.completed'], // Optional: filter by type
    onStats: (stats) => {},              // Optional: DispatchProcessStats
    maxExecutionMs: 600_000,             // Optional: deadline for this call
    phases: 'all',                       // 'pending': no lease reclaim
  }
);
// Returns the rows whose handler succeeded and whose outcome this call wrote.

// Read-only: what process() would claim, with each row's phase
// ('expired' | 'legacy' | 'undated' | 'dated').
const preview = await bus.previewProcess('Fiscus', { limit: 20 });
```

A handler that throws marks its dispatch `failed`. If the bus cannot record
an outcome at all (the database write throws), the dispatch stays
`processing` under its lease (reclaimed after the lease expires), a
`dispatch.settle_error` warning is logged, and the rest of the batch still
runs.

Bus options for the lease: `leaseMs` (default 300000, integer >= 1000),
`maxAttempts` (default 5, integer >= 1), `maxExecutionMs` (unset by
default; integer >= `leaseMs`), `legacyLeaseGraceMs` (unset by default;
positive integer), `leaseDb` (dedicated handle for renewals and outcome
writes). Invalid values throw naming the option.

### bus.maintain(options)

Fail abandoned leases no subscription routes and, optionally, release
leases (see Maintenance).

```typescript
const { orphaned, released, dryRun } = await bus.maintain({
  orphanedLeaseAfterMs: 86_400_000, // Optional (default one day)
  release: 'expired',               // Optional: 'expired' | 'afterDrain' | 'legacy'
  sweepOrphans: true,               // Optional (default true)
  dryRun: false,                    // Optional: count only
});
```

### bus.retry(options)

Retry failed dispatches.

```typescript
const count = await bus.retry({
  maxAttempts: 3,                      // Only retry if under this limit
                                       // (default: the row's claim budget)
  resetAttempts: false,                // true: attempts back to 0, any count
  signalTypes: ['campaign.completed'] // Optional: exact types (no wildcards)
});
// Returns the number of rows this call moved back to pending. Rows another
// worker claimed or completed in the meantime are left alone.
```

### bus.cleanup(options)

Delete old dispatches.

```typescript
const result = await bus.cleanup({
  completedOlderThanDays: 30,
  failedOlderThanDays: 90
});
// result: { completedDeleted: 150, failedDeleted: 5 }
```

### bus.list(options)

List dispatches with filtering.

```typescript
const dispatches = await bus.list({
  status: 'pending',           // Optional: filter by status
  source: 'Suasor',            // Optional: filter by source
  type: 'campaign.completed',  // Optional: filter by type
  reason: 'DISPATCH_ATTEMPTS_EXHAUSTED', // Optional: exact framework reason
  limit: 50,                   // Optional: max results
  offset: 0                    // Optional: pagination offset
});
```

## Best Practices

### 1. Use Descriptive Signal Types

```typescript
// ✅ GOOD - Clear hierarchy
'campaign.completed'
'order.payment.failed'
'agent.fiscus.ready'

// ❌ BAD - Ambiguous
'done'
'error'
'data'
```

### 2. Include Source in Emit Options

```typescript
// ✅ GOOD - Traceable
await bus.emit('event', payload, { source: 'Suasor', sourceId: 'instance-1' });

// ❌ BAD - Unknown origin
await bus.emit('event', payload);
```

### 3. Handle Failures Gracefully

```typescript
await bus.process('Fiscus', async (payload, metadata) => {
  try {
    await processPayload(payload);
  } catch (error) {
    // Log but rethrow to mark as failed
    console.error(`Failed to process ${metadata.id}:`, error);
    throw error;
  }
});
```

### 4. Use Wildcards for Monitoring

```typescript
// Monitor all events for logging/metrics
await bus.subscribe({
  signalType: '*',
  subscriber: 'MetricsCollector'
});
```

### 5. Clean Up Regularly

```typescript
// In a scheduled job
await bus.cleanup({
  completedOlderThanDays: 7,
  failedOlderThanDays: 30
});
```
