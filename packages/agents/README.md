# @happyvertical/smrt-agents

Agent framework for building autonomous actors with lifecycle management, inter-agent messaging, interest-based discovery, scheduling, and multi-tenant bindings.

## Installation

```bash
pnpm add @happyvertical/smrt-agents
```

## Usage

```typescript
import { Agent, type AgentOptions } from '@happyvertical/smrt-agents';
import { smrt } from '@happyvertical/smrt-core';
import { getModuleConfig } from '@happyvertical/smrt-config';

@smrt()
class MyAgent extends Agent {
  protected config = getModuleConfig('my-agent', {
    cronSchedule: '0 2 * * *',
    maxRetries: 3,
  });

  itemsProcessed: number = 0;

  constructor(options: AgentOptions = {}) {
    super({
      ...options,
      interests: {
        objects: {
          Meeting: { filter: { status: 'upcoming' } },
          Document: { filter: { 'type in': ['agenda', 'minutes'] } },
        },
      },
    });
  }

  async validate(): Promise<void> {
    if (!this.config.cronSchedule) throw new Error('cronSchedule required');
  }

  async run(): Promise<void> {
    const items = await this.interesting();
    for (const { type, data } of items) {
      this.logger.info(`Processing ${type}: ${data.id}`);
    }
    this.itemsProcessed = items.length;
    await this.save();
  }
}

const agent = new MyAgent({ name: 'my-agent' });
await agent.execute(); // initialize() -> validate() -> run() -> shutdown()
```

If you are running a single-agent CLI or script and want built-in
`SIGTERM`/`SIGINT` handling, pass `manageProcessSignals: true` to the
constructor. Multi-agent hosts should leave that off and coordinate process
shutdown themselves.

## Scheduled Methods Vs Operator Actions

Use scheduled agent methods for the regular, repeatable maintenance path: the
work that should happen automatically every time the schedule fires. Keep those
methods idempotent and safe to rerun.

When operators need a composite catch-up or repair flow, expose that as an
explicit method such as `forage()`, `backfill()`, or `rebuildIndex()` instead of
overloading `run()` with manual-only behavior. Those operator actions can still
be enqueued through `@happyvertical/smrt-jobs`, but they should remain distinct
from the normal scheduled loop so it stays obvious which work is automatic and
which work is an intentional intervention.

## API

### Main Export (`@happyvertical/smrt-agents`)

| Export | Description |
|--------|------------|
| `Agent` | Base agent class with lifecycle and interests |
| `AgentOptions` | Constructor options type |
| `AgentStatusType` | Status enum: idle/initializing/running/error/shutdown |
| `AgentConfig` | DB-persisted agent configuration model |
| `AgentConfigCollection` | Collection for AgentConfig |
| `AgentSchedule` | Cron-based schedule model (`_smrt_agent_schedules`) |
| `AgentScheduleCollection` | Collection for AgentSchedule |
| `ScheduleStatus` | Schedule status type |
| `TenantAgent` | Agent-to-tenant junction with hierarchy resolution |
| `TenantAgentCollection` | Collection for TenantAgent |
| `TenantAgentStatus` | Tenant agent status type |
| `ResolvedAgentAvailability` | Resolved availability after hierarchy walk |
| `mergeFilters` | Combine interest filters |
| `normalizeSort` | Normalize sort expressions |
| `InterestOptions` | Interest configuration type |
| `InterestFilter` | Filter definition type |
| `InterestResult` | Discovery result type |
| `ObjectInterestConfig` | Per-object interest config type |
| `ObjectFilter` | Object filter type |
| `InterestHandlerFn` | Interest handler function type |
| `AsyncQualifierFn` | Async post-filter qualifier type |
| `QueryFn` | Query function type |
| `AgentWithInterestsOptions` | Agent options with interests |

### UI Export (`@happyvertical/smrt-agents/ui`)

| Export | Description |
|--------|------------|
| `AgentUIRegistry` | Singleton registry for agent admin panels |
| `createUIRegistry` | Factory for UI registries |
| `AgentUISlot` | UI slot definition type |
| `AgentUISlots` | Map of UI slots |
| `AgentAdminRoute` | Admin route metadata (path, component, load) |
| `AgentAdminExport` | Agent admin module export shape |
| `AgentAdminNavItem` | Navigation item for admin sidebar |
| `AgentAdminRootProps` | Props for admin root component |
| `AdminPanelBaseProps` | Props for admin panel components |
| `AgentManifestInfo` | Agent manifest metadata |
| `AgentRouteLoadContext` | Normalized SvelteKit load context |
| `AgentRouteLoadFn` | Server load function type |
| `AgentUIComponentRegistry` | Component registry type |
| `ComponentType` | Generic component type |

### Vite Export (`@happyvertical/smrt-agents/vite`)

| Export | Description |
|--------|------------|
| `vitePluginAgentRoutes` | Vite plugin for `virtual:smrt-agent-registrations` |
| `AgentRoutesPluginOptions` | Plugin options type |

## Dependencies

- `@happyvertical/smrt-core` -- ORM base classes
- `@happyvertical/smrt-config` -- Configuration management
- `@happyvertical/smrt-tenancy` -- Multi-tenant context
- `@happyvertical/ai` -- AI client (SDK)
- `@happyvertical/files` -- Filesystem utilities (SDK)
- `@happyvertical/utils` -- Shared utilities (SDK)
- `@happyvertical/smrt-ui` -- UI runtime (i18n client, primitives, module registry) for the optional `./svelte` components, including the agent-admin shells (`AgentAdminPanel`, `AgentAdminTabs`, `AgentSettingsShell`) that moved here from smrt-svelte in #1589
- Peer (optional): `svelte`
