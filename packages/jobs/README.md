# @happyvertical/smrt-jobs

Background job execution for SMRT objects. Provides persistent queue storage, retry strategies, cron-based scheduling, and a fluent `JobBuilder` API via the `withBackgroundJobs()` mixin.

## Installation

```bash
pnpm add @happyvertical/smrt-jobs
```

## Usage

### Add background capabilities to a SmrtObject

```typescript
import { withBackgroundJobs, TaskRunner } from '@happyvertical/smrt-jobs';
import { Document } from './document.js';

// Mixin adds .bg() and .background() to any SmrtObject class
const BackgroundDocument = withBackgroundJobs(Document);
const doc = new BackgroundDocument({ db });
await doc.initialize();

// Quick enqueue — runs immediately when a TaskRunner picks it up
const handle = await doc.bg('generateSummary', { format: 'md' });

// Fluent builder for advanced options
const handle2 = await doc.background('generateSummary', { format: 'md' })
  .delay('5m')
  .priority('high')
  .retries(5)
  .queue('analysis')
  .timeout(600000)
  .enqueue();

// Wait for result (polling-based)
const result = await handle2.wait({ timeout: 60000, pollInterval: 100 });
```

### Run a TaskRunner to process jobs

```typescript
import { TaskRunner } from '@happyvertical/smrt-jobs';

const runner = new TaskRunner({
  concurrency: 5,
  pollInterval: 1000,
  queues: ['default', 'analysis'],
});
await runner.initialize(db);
await runner.start();

// Listen for events
runner.on('job:completed', (job, result) => { /* ... */ });
runner.on('job:failed', (job, error) => { /* ... */ });

// Graceful shutdown
process.on('SIGTERM', () => runner.stop());
```

### Schedule recurring jobs with ScheduleRunner

The `ScheduleRunner` polls the `_smrt_agent_schedules` table for due cron entries and creates `SmrtJob` records for the `TaskRunner` to execute. Wire them together via events:

```typescript
import { ScheduleRunner } from '@happyvertical/smrt-jobs';

const scheduleRunner = new ScheduleRunner({ pollInterval: 30000 });
await scheduleRunner.initialize(db);
await scheduleRunner.start();

// Connect TaskRunner events to update schedule state
taskRunner.on('job:completed', (job) => {
  const scheduleId = job.args?._scheduleId;
  if (scheduleId) scheduleRunner.handleJobCompletion(scheduleId, true);
});
taskRunner.on('job:failed', (job, error) => {
  const scheduleId = job.args?._scheduleId;
  if (scheduleId) scheduleRunner.handleJobCompletion(scheduleId, false, error.message);
});
```

### System Tables

| Table | Purpose |
|-------|---------|
| `_smrt_jobs` | Persistent job queue (SmrtJob records) |
| `_smrt_agent_schedules` | Cron schedule entries polled by ScheduleRunner |

## API

### Classes

| Export | Description |
|--------|------------|
| `SmrtJob` | Persistent job record stored in `_smrt_jobs` |
| `SmrtJobCollection` | Collection with `listReady()`, `listByStatus()`, `stats()`, `cleanup()` |
| `JobBuilder` | Fluent API: `.delay()`, `.priority()`, `.retries()`, `.queue()`, `.timeout()`, `.enqueue()` |
| `JobHandle` | Track, wait, cancel, or retry an enqueued job |
| `JobContextLogger` | Logger that auto-injects job context (jobId, attempt, queue) |
| `TaskRunner` | Polling-based execution engine with concurrency control and heartbeats |
| `ScheduleRunner` | Polls for due cron schedules and creates SmrtJob entries |

### Functions

| Export | Description |
|--------|------------|
| `createTaskRunner(config?)` | Factory for creating a configured TaskRunner |
| `createScheduleRunner(config?)` | Factory for creating a configured ScheduleRunner |
| `withBackgroundJobs(Class)` | Mixin that adds `.bg()` and `.background()` to any SmrtObject class |
| `parseDelay(delay)` | Parse human-readable delay strings (`'5m'`, `'1h'`, `'30s'`) to milliseconds |
| `priorityToNumber(priority)` | Convert priority label (`'critical'`/`'high'`/`'normal'`/`'low'`) to number |

### Key Types

`Priority`, `JobStatus`, `JobResult`, `WaitOptions`, `BgOptions`, `BackgroundCapable`, `TaskRunnerConfig`, `TaskRunnerEvents`, `ScheduleRunnerConfig`, `ScheduleRunnerEvents`, `ScheduleInfo`, `JobContext`, `TimeoutBehavior`, `SmrtJobData`, `ListReadyOptions`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-types` -- shared type definitions
- `@happyvertical/jobs` -- retry strategies
- `@happyvertical/sql` -- database interface
- `@happyvertical/logger` -- structured logging
- `@happyvertical/utils` -- ID generation utilities
- Peer (optional): `@happyvertical/smrt-svelte`, `svelte`
