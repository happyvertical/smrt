# @happyvertical/smrt-agents

Agent framework for building autonomous actors in the SMRT ecosystem.

## Svelte Components

This package includes Svelte 5 UI components for agent schedule management.

### Installation

```bash
npm install @happyvertical/smrt-agents
```

### Usage

```typescript
import {
  AgentDashboard,
  AgentScheduleList,
  AgentScheduleForm,
  AgentRunHistory,
  ScheduleStatusBadge,
} from '@happyvertical/smrt-agents/svelte';
```

### Components

- **AgentDashboard** - Combined overview panel for agent schedules
- **AgentScheduleList** - List of scheduled agents with actions
- **AgentScheduleForm** - Form for creating/editing schedules
- **AgentRunHistory** - History of agent runs
- **ScheduleStatusBadge** - Status indicator for schedules

### Types

```typescript
import type {
  AgentScheduleData,
  AgentRunHistoryEntry,
  ScheduleStatus,
  RunStatus,
} from '@happyvertical/smrt-agents/svelte';
```

### Auto-registration

Importing from `/svelte` auto-registers components with `ModuleUIRegistry`:

```typescript
import '@happyvertical/smrt-agents/svelte'; // Auto-registers all components

// Later, retrieve from registry
const Component = ModuleUIRegistry.get('@happyvertical/smrt-agents', 'agent-dashboard');
```
