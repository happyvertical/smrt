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
  malformed, exhausted, scanRejects).

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
reclaimed automatically. Rows whose `attempts` already reached the budget
become `failed` with `[smrt:DISPATCH_ATTEMPTS_EXHAUSTED]` when polled;
revive them with `retry({ resetAttempts: true })`.

Rollback: stop the new processes and wait `leaseMs` so every lease expires,
then confirm no `processing` row has a non-NULL `lease_token` before
starting older code; release any that remain to `pending` first. Older code
ignores the extra columns.

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

# Process pending for a subscriber
smrt dispatch:process --subscriber Fiscus

# Retry failed dispatches
smrt dispatch:retry --max-attempts 3

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
    limit: 100,                         // Optional: max rows claimed
    signalTypes: ['campaign.completed'], // Optional: filter by type
    onStats: (stats) => {},             // Optional: DispatchProcessStats
  }
);
// Returns the rows whose handler succeeded and whose outcome this call wrote.
```

Bus options for the lease: `leaseMs` (default 300000, integer >= 1000),
`maxAttempts` (default 5, integer >= 1), `leaseDb` (dedicated handle for
renewals and outcome writes). Invalid values throw naming the option.

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
