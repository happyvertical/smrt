# Feature Spec: Background Workers for SMRT

## Overview

Add background job execution capabilities to the SMRT ecosystem, enabling any SmrtObject method to run asynchronously with persistence, retries, and scheduling.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    SDK: @happyvertical/jobs                      │
│                    (New package in SDK repo)                     │
├─────────────────────────────────────────────────────────────────┤
│  Core Abstractions:                                             │
│  • Job, JobHandle, JobStatus, JobResult                         │
│  • Worker, WorkerPool                                           │
│  • RetryStrategy (exponential, linear, custom)                  │
│  • JobStore (abstract persistence interface)                    │
│                                                                 │
│  Built-in Adapters:                                             │
│  • SqliteJobStore (default, zero-config)                        │
│  • PostgresJobStore (with NOTIFY/LISTEN for push)               │
│                                                                 │
│  External Adapters:                                             │
│  • BullJobStore (Redis)                                         │
│  • BullMQJobStore (Redis)                                       │
│  • SQSJobStore (AWS)                                            │
│  • CloudTasksJobStore (GCP)                                     │
│                                                                 │
│  Push Notification Layer:                                       │
│  • PostgresNotifyListener (true push via pg_notify)             │
│  • SqlitePollListener (short-interval polling fallback)         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  SMRT: @happyvertical/smrt-jobs                  │
│                  (New package in SMRT repo)                      │
├─────────────────────────────────────────────────────────────────┤
│  Models:                                                        │
│  • SmrtJob extends SmrtObject                                   │
│  • JobResultPointer (reference to external result storage)      │
│                                                                 │
│  SmrtObject Extension (mixin or base class enhancement):        │
│  • .bg(method, args) → JobHandle                                │
│  • .background(method, args) → JobBuilder (fluent API)          │
│                                                                 │
│  TaskRunner:                                                    │
│  • Subscribes to DispatchBus for 'job.*' events                 │
│  • Executes jobs via SmrtObject method invocation               │
│  • Configurable concurrency, timeout behavior                   │
│  • Embedded mode (in-process) or standalone (CLI)               │
│                                                                 │
│  Logger Extension:                                              │
│  • Auto-inject job context: { jobId, attempt, queue }           │
│  • All logs during job execution tagged automatically           │
│                                                                 │
│  CLI Commands:                                                  │
│  • smrt job:work [--concurrency N] [--queues Q1,Q2]            │
│  • smrt <object>:<method> [args] --bg [--delay] [--retries]    │
│  • smrt job:list [--status pending|running|failed|completed]   │
│  • smrt job:get <id>                                           │
│  • smrt job:retry <id>                                         │
│  • smrt job:cancel <id>                                        │
│  • smrt job:stats                                              │
│                                                                 │
│  UI Components (Svelte 5):                                      │
│  • <JobList /> - Filterable, sortable job list                 │
│  • <JobDetail /> - Single job view with logs, attempts, result │
│  • <JobActions /> - Retry, cancel, delete action buttons       │
│  • <JobStats /> - Queue depth, success rate, avg duration      │
│  • <JobDashboard /> - Combined overview panel                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│              SMRT: @happyvertical/smrt-agents (existing)         │
│              (Enhanced with scheduling)                          │
├─────────────────────────────────────────────────────────────────┤
│  New Models:                                                    │
│  • AgentSchedule extends SmrtObject                             │
│    - agentType, agentConfig, cron, enabled, lastRun, nextRun   │
│                                                                 │
│  Integration:                                                   │
│  • Uses smrt-jobs TaskRunner under the hood                     │
│  • Cron parsing creates SmrtJob at scheduled times              │
│                                                                 │
│  CLI Commands:                                                  │
│  • smrt agent:schedule create <agent> --cron "0 2 * * *"       │
│  • smrt agent:schedule list                                    │
│  • smrt agent:schedule enable/disable <id>                     │
│  • smrt agent:schedule delete <id>                             │
│                                                                 │
│  UI Components (Svelte 5):                                      │
│  • <AgentScheduleList /> - List of scheduled agents            │
│  • <AgentScheduleForm /> - Create/edit schedule                │
│  • <AgentRunHistory /> - Past executions for an agent          │
│  • <AgentDashboard /> - Agent management overview              │
└─────────────────────────────────────────────────────────────────┘
```

## Push-Based Event Flow

```
┌─────────────┐     INSERT      ┌─────────────────┐
│  Your Code  │ ───────────────▶│   _smrt_jobs    │
│             │                 │     table       │
│ doc.bg(...) │                 └────────┬────────┘
└─────────────┘                          │
                                         │ DB Trigger
                                         ▼
                            ┌────────────────────────┐
                            │  Postgres: NOTIFY      │
                            │  SQLite: Poll + flag   │
                            └───────────┬────────────┘
                                        │
                                        ▼
                            ┌────────────────────────┐
                            │     DispatchBus        │
                            │  'job.created'         │
                            │  'job.ready'           │
                            │  'job.completed'       │
                            │  'job.failed'          │
                            └───────────┬────────────┘
                                        │
                  ┌─────────────────────┼─────────────────┐
                  ▼                     ▼                 ▼
         ┌──────────────┐      ┌──────────────┐   ┌──────────┐
         │TaskRunner #1 │      │TaskRunner #2 │   │Runner #N │
         │ (embedded)   │      │ (standalone) │   │          │
         └──────────────┘      └──────────────┘   └──────────┘
```

## Core APIs

### SDK: @happyvertical/jobs

```typescript
// Job interface
interface Job {
  id: string;
  queue: string;
  payload: {
    objectType: string;
    objectId: string | null;
    method: string;
    args: Record<string, any>;
  };
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  timeout: number;
  timeoutBehavior: 'fail' | 'kill' | 'warn';
  lastError: string | null;
  resultPointer: string | null;  // URI to result storage
  retryStrategy: RetryStrategyConfig;
  createdAt: Date;
  updatedAt: Date;
}

// Job Store interface (adapters implement this)
interface JobStore {
  enqueue(job: Partial<Job>): Promise<Job>;
  dequeue(queues: string[], limit: number): Promise<Job[]>;
  update(id: string, updates: Partial<Job>): Promise<Job>;
  get(id: string): Promise<Job | null>;
  list(filter: JobFilter): Promise<Job[]>;
  cancel(id: string): Promise<void>;
  cleanup(options: CleanupOptions): Promise<number>;
  subscribe(listener: JobEventListener): Unsubscribe;
}

// Retry strategies
import { exponential, linear, custom } from '@happyvertical/jobs';

const strategy = exponential({
  initialDelay: 1000,
  maxDelay: 300000,
  multiplier: 2,
  jitter: true,
});

const linearStrategy = linear({ delay: 5000 });

const customStrategy = custom((attempt, error) => {
  if (error.code === 'RATE_LIMITED') {
    return { delay: 60000, shouldRetry: true };
  }
  return { delay: attempt * 1000, shouldRetry: attempt < 3 };
});
```

### SMRT: @happyvertical/smrt-jobs

```typescript
// Programmatic API - Simple
const handle = await doc.bg('generateSummary', { format: 'md' });
console.log(handle.id);  // 'job_abc123'

// Programmatic API - Fluent builder
const handle = await doc.background('generateSummary', { format: 'md' })
  .delay('5m')
  .retries(5)
  .retryStrategy(exponential({ initialDelay: 1000 }))
  .priority('high')
  .queue('summaries')
  .timeout(300000)
  .timeoutBehavior('fail')
  .enqueue();

// Wait for result (optional)
const result = await handle.wait();
const result = await handle.wait({ timeout: 60000 });

// Check status
const status = await handle.status();  // 'running'

// Cancel
await handle.cancel();

// TaskRunner - Embedded mode
import { TaskRunner } from '@happyvertical/smrt-jobs';

const runner = new TaskRunner({
  concurrency: 5,
  queues: ['default', 'summaries', 'high-priority'],
  pollInterval: 100,  // SQLite fallback
});

runner.on('job:started', (job) => logger.info('Started', { jobId: job.id }));
runner.on('job:completed', (job, result) => logger.info('Done', { jobId: job.id }));
runner.on('job:failed', (job, error) => logger.error('Failed', { jobId: job.id, error }));

await runner.start();

// Graceful shutdown
process.on('SIGTERM', () => runner.stop());
```

### CLI Usage

```bash
# Background any command with --bg flag
smrt document:summarize abc123 --format md --bg
# Output: Job enqueued: job_abc123 (smrt job:get job_abc123)

smrt document:summarize abc123 --bg --delay 5m --retries 3

# Start worker (standalone mode)
smrt job:work
smrt job:work --concurrency 10
smrt job:work --queues high-priority,default

# Job management
smrt job:list
smrt job:list --status failed
smrt job:list --queue summaries --limit 50

smrt job:get job_abc123
smrt job:retry job_abc123
smrt job:retry --status failed --limit 100  # Bulk retry
smrt job:cancel job_abc123

smrt job:stats
# Output:
# Queue: default
#   Pending: 42
#   Running: 5
#   Completed (24h): 1,234
#   Failed (24h): 12
#   Avg Duration: 2.3s

smrt job:cleanup --completed-before 7d --failed-before 30d
```

## Data Models

### SmrtJob

```typescript
@smrt({
  tableName: '_smrt_jobs',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get', 'retry', 'cancel'] },
})
class SmrtJob extends SmrtObject {
  queue: string = 'default';

  // What to execute
  objectType: string = '';
  objectId: string | null = null;
  method: string = '';
  args: Record<string, any> = {};

  // Scheduling
  runAt: Date = new Date();
  priority: number = 0;

  // Execution
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' = 'pending';
  attempts: number = 0;
  maxAttempts: number = 3;
  timeout: number = 300000;
  timeoutBehavior: 'fail' | 'kill' | 'warn' = 'fail';

  // Results
  startedAt: Date | null = null;
  completedAt: Date | null = null;
  lastError: string | null = null;
  resultPointer: string | null = null;  // e.g., 'db:job_results:abc123' or 's3:bucket/results/abc123.json'

  // Retry config (stored as JSON)
  retryStrategy: {
    type: 'exponential' | 'linear' | 'custom';
    config: Record<string, any>;
  } = { type: 'exponential', config: { initialDelay: 1000, multiplier: 2 } };

  // Worker tracking
  workerId: string | null = null;
  workerHeartbeat: Date | null = null;
}
```

### AgentSchedule (in smrt-agents)

```typescript
@smrt({
  tableName: '_smrt_agent_schedules',
  cli: { include: ['list', 'get', 'create', 'update', 'delete', 'enable', 'disable'] },
})
class AgentSchedule extends SmrtObject {
  agentType: string = '';           // 'Praeco', 'Scraper', etc.
  agentConfig: Record<string, any> = {};

  // Schedule
  cron: string = '';                // '0 2 * * *'
  timezone: string = 'UTC';
  enabled: boolean = true;

  // Execution tracking
  lastRun: Date | null = null;
  nextRun: Date | null = null;
  lastStatus: 'success' | 'failed' | null = null;
  lastError: string | null = null;
  runCount: number = 0;

  // Constraints
  maxConcurrent: number = 1;        // Prevent overlapping runs
  timeout: number = 3600000;        // 1 hour default for agents
}
```

## Database Triggers (PostgreSQL)

```sql
-- Trigger function for job creation
CREATE OR REPLACE FUNCTION smrt_notify_job_created()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('smrt_jobs', json_build_object(
    'event', 'created',
    'id', NEW.id,
    'queue', NEW.queue,
    'priority', NEW.priority,
    'run_at', NEW.run_at
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER smrt_job_created_trigger
AFTER INSERT ON _smrt_jobs
FOR EACH ROW EXECUTE FUNCTION smrt_notify_job_created();

-- Trigger for job ready (when run_at passes)
CREATE OR REPLACE FUNCTION smrt_notify_job_ready()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'pending' AND NEW.run_at <= NOW() AND
     (OLD.run_at > NOW() OR OLD IS NULL) THEN
    PERFORM pg_notify('smrt_jobs', json_build_object(
      'event', 'ready',
      'id', NEW.id,
      'queue', NEW.queue,
      'priority', NEW.priority
    )::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER smrt_job_ready_trigger
AFTER UPDATE ON _smrt_jobs
FOR EACH ROW EXECUTE FUNCTION smrt_notify_job_ready();
```

## Logger Extension

```typescript
// During job execution, all logs automatically include job context
class JobContextLogger {
  constructor(private baseLogger: Logger, private jobContext: JobContext) {}

  info(message: string, data?: Record<string, any>) {
    this.baseLogger.info(message, {
      ...data,
      _job: {
        id: this.jobContext.jobId,
        attempt: this.jobContext.attempt,
        queue: this.jobContext.queue,
        objectType: this.jobContext.objectType,
        method: this.jobContext.method,
      }
    });
  }

  // ... error, warn, debug, etc.
}

// Usage in TaskRunner
async executeJob(job: SmrtJob) {
  const contextLogger = new JobContextLogger(this.logger, {
    jobId: job.id,
    attempt: job.attempts + 1,
    queue: job.queue,
    objectType: job.objectType,
    method: job.method,
  });

  // Inject into execution context
  const instance = await this.loadInstance(job);
  instance.logger = contextLogger;

  await instance[job.method](job.args);
}
```

## UI Components

### smrt-jobs Components

```svelte
<!-- JobList.svelte -->
<script lang="ts">
  import type { SmrtJob } from '@happyvertical/smrt-jobs';

  let {
    jobs = $bindable<SmrtJob[]>([]),
    filter = $bindable({ status: 'all' }),
    onRetry,
    onCancel,
    onSelect
  } = $props();
</script>

<!-- JobDetail.svelte -->
<script lang="ts">
  let { job, onRetry, onCancel } = $props();
</script>

<!-- JobStats.svelte -->
<script lang="ts">
  let { stats } = $props();
  // { pending, running, completed24h, failed24h, avgDuration }
</script>

<!-- JobDashboard.svelte -->
<script lang="ts">
  // Combines JobStats + JobList with real-time updates
</script>
```

### smrt-agents Components

```svelte
<!-- AgentScheduleList.svelte -->
<!-- AgentScheduleForm.svelte -->
<!-- AgentRunHistory.svelte -->
<!-- AgentDashboard.svelte -->
```

## Implementation Phases

### Phase 1: SDK Foundation (@happyvertical/jobs)
- [ ] Core interfaces: Job, JobStore, RetryStrategy
- [ ] SqliteJobStore implementation
- [ ] PostgresJobStore with NOTIFY/LISTEN
- [ ] Retry strategies: exponential, linear, custom
- [ ] Tests and documentation

### Phase 2: SMRT Integration (@happyvertical/smrt-jobs)
- [ ] SmrtJob model
- [ ] SmrtObject.bg() and .background() methods
- [ ] TaskRunner (embedded + standalone modes)
- [ ] DispatchBus integration for push events
- [ ] Logger extension with job context
- [ ] CLI commands: job:work, job:list, job:get, job:retry, job:cancel
- [ ] --bg flag for any command
- [ ] Tests and documentation

### Phase 3: Agent Scheduling (@happyvertical/smrt-agents)
- [ ] AgentSchedule model
- [ ] Cron parsing and next-run calculation
- [ ] Integration with smrt-jobs TaskRunner
- [ ] CLI commands: agent:schedule create/list/enable/disable
- [ ] Tests and documentation

### Phase 4: UI Components
- [ ] smrt-jobs: JobList, JobDetail, JobStats, JobDashboard
- [ ] smrt-agents: AgentScheduleList, AgentScheduleForm, AgentRunHistory
- [ ] Real-time updates via DispatchBus → SSE

### Phase 5: External Adapters (SDK)
- [ ] BullJobStore
- [ ] BullMQJobStore
- [ ] SQSJobStore
- [ ] CloudTasksJobStore

## Configuration

```javascript
// smrt.config.js
export default {
  packages: {
    jobs: {
      // Job store configuration
      store: {
        type: 'postgres',  // 'sqlite' | 'postgres' | 'bull' | 'bullmq' | 'sqs'
        url: process.env.DATABASE_URL,
        // For Redis-based stores
        redis: {
          host: 'localhost',
          port: 6379,
        },
      },

      // Default job options
      defaults: {
        maxAttempts: 3,
        timeout: 300000,
        timeoutBehavior: 'fail',
        retryStrategy: {
          type: 'exponential',
          config: { initialDelay: 1000, multiplier: 2, maxDelay: 300000 },
        },
      },

      // Worker configuration
      worker: {
        concurrency: 5,
        queues: ['high-priority', 'default', 'low-priority'],
        pollInterval: 100,  // For SQLite fallback
        shutdownTimeout: 30000,
      },

      // Result storage
      results: {
        store: 'database',  // 'database' | 's3' | 'none'
        ttl: '7d',          // Auto-cleanup after 7 days
      },
    },

    agents: {
      scheduling: {
        enabled: true,
        defaultTimeout: 3600000,
        maxConcurrentPerAgent: 1,
      },
    },
  },
};
```

## Open Questions / Future Considerations

1. **Job Priorities**: Should we support priority queues or separate queue names?
   - Decision: Both - priority within queue + multiple queues

2. **Dead Letter Queue**: Should failed jobs after max attempts go to a DLQ?
   - Consider for Phase 2

3. **Job Dependencies**: Should jobs be able to depend on other jobs?
   - Consider for future (workflow engine territory)

4. **Rate Limiting**: Should we support rate limits per queue?
   - Consider for Phase 2

5. **Metrics/Observability**: Integration with Prometheus/StatsD?
   - Consider for Phase 4 (alongside UI)
