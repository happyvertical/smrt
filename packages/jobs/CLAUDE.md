# @happyvertical/smrt-jobs

Background job processing for SMRT objects with persistence and scheduling.

## Svelte Components

This package includes Svelte 5 UI components for background job management.

### Installation

```bash
npm install @happyvertical/smrt-jobs
```

### Usage

```typescript
import {
  JobDashboard,
  JobList,
  JobDetail,
  JobStats,
  JobActions,
  JobStatusBadge,
} from '@happyvertical/smrt-jobs/svelte';
```

### Components

- **JobDashboard** - Combined overview panel for background jobs
- **JobList** - Filterable, sortable list of jobs
- **JobDetail** - Detailed view of a single job
- **JobStats** - Statistics dashboard for job queues
- **JobActions** - Action buttons for job operations
- **JobStatusBadge** - Status indicator for jobs

### Types

```typescript
import type {
  JobData,
  JobStats,
  QueueStats,
  JobStatus,
  JobPriority,
} from '@happyvertical/smrt-jobs/svelte';
```

### Auto-registration

Importing from `/svelte` auto-registers components with `ModuleUIRegistry`:

```typescript
import '@happyvertical/smrt-jobs/svelte'; // Auto-registers all components

// Later, retrieve from registry
const Component = ModuleUIRegistry.get('@happyvertical/smrt-jobs', 'job-dashboard');
```
