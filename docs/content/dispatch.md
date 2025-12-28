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
- `*` matches exactly one segment (anything except `.`)
- `campaign.*` matches `campaign.started` but NOT `campaign.summer.started`
- Multiple wildcards allowed: `*.*.completed`

## Dispatch Lifecycle

```
pending → processing → completed
                   ↘ failed → (retry) → pending
```

**Status Values:**
- `pending`: Waiting to be processed
- `processing`: Currently being handled
- `completed`: Successfully processed
- `failed`: Handler threw an error

## Retry Failed Dispatches

```typescript
// Retry failed dispatches (up to 3 attempts)
const count = await bus.retry({ maxAttempts: 3 });
console.log(`Reset ${count} dispatches for retry`);

// Then process again
await bus.process('Fiscus', handler);
```

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

# Cleanup old dispatches
smrt dispatch:cleanup --completed-older-than 30

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
| attempts | INTEGER | Number of processing attempts |
| last_error | TEXT | Error message from last failure |
| processed_at | DATETIME | When processing completed |
| processed_by | TEXT | Subscriber that processed |
| metadata | TEXT | JSON-encoded trace metadata |

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
    limit: 100,                         // Optional: max to process
    signalTypes: ['campaign.completed'] // Optional: filter by type
  }
);
```

### bus.retry(options)

Retry failed dispatches.

```typescript
const count = await bus.retry({
  maxAttempts: 3,            // Only retry if under this limit
  signalTypes: ['campaign.*'] // Optional: filter by type
});
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
