# @happyvertical/smrt-jobs

Background job processing for the SMRT framework. Provides a fluent `JobBuilder` API, persistent job storage, scheduled execution, and a `withBackgroundJobs()` mixin for adding background capabilities to any SmrtCollection.

## Installation

```bash
pnpm add @happyvertical/smrt-jobs
```

## Usage

```typescript
import {
  JobBuilder, TaskRunner, ScheduleRunner,
  createTaskRunner, createScheduleRunner,
  withBackgroundJobs, parseDelay
} from '@happyvertical/smrt-jobs';

// Fluent job building
const job = new JobBuilder()
  .task('process-invoice')
  .payload({ invoiceId: 'inv-123' })
  .priority('high')
  .delay('5m')
  .maxRetries(3)
  .build();

// Task runner for processing jobs
const runner = createTaskRunner({
  db,
  concurrency: 5,
  pollInterval: 1000,
});

runner.register('process-invoice', async (ctx) => {
  const { invoiceId } = ctx.payload;
  // Process the invoice...
  return { success: true };
});

await runner.start();

// Schedule runner for cron-like jobs
const scheduler = createScheduleRunner({
  db,
  timezone: 'America/New_York',
});
await scheduler.start();

// Add background jobs to any collection via mixin
const BgProducts = withBackgroundJobs(ProductCollection);
```

## API

### Classes

| Export | Description |
|--------|------------|
| `JobBuilder` | Fluent API for constructing job definitions |
| `JobHandle` | Handle returned when a job is enqueued |
| `JobContextLogger` | Scoped logger for job execution context |
| `TaskRunner` | Processes queued jobs with concurrency control |
| `ScheduleRunner` | Executes jobs on cron-like schedules |
| `SmrtJob` | Persistent job record model |
| `SmrtJobCollection` | Collection for querying/managing jobs |

### Functions

| Export | Description |
|--------|------------|
| `createTaskRunner` | Factory for creating a configured TaskRunner |
| `createScheduleRunner` | Factory for creating a configured ScheduleRunner |
| `withBackgroundJobs` | Mixin that adds background job capabilities to a collection |
| `parseDelay` | Parse human-readable delay strings (e.g., `'5m'`, `'1h'`) |
| `priorityToNumber` | Convert priority label to numeric value |

### Key Types

`Priority`, `JobResult`, `JobStatus`, `JobContext`, `TaskRunnerConfig`, `ScheduleRunnerConfig`, `ScheduleInfo`, `BackgroundCapable`, `TimeoutBehavior`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-config` — configuration loading
- `@happyvertical/smrt-types` — shared type definitions
- Peer: `@happyvertical/smrt-svelte`
