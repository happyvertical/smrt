# @happyvertical/smrt-agents: Autonomous Agent Framework

## Purpose and Responsibilities

The `@happyvertical/smrt-agents` package provides a comprehensive framework for building autonomous actors in the SMRT ecosystem. It handles:

- **Agent Lifecycle**: Initialize, validate, run, and shutdown hooks with automatic orchestration
- **Status Tracking**: Built-in status management (idle, initializing, running, error, shutdown)
- **Configuration Persistence**: Database-backed configuration with AgentConfig SmrtObject
- **Config Export**: Export configurations for static site generation
- **UI Slots**: Declarative admin panel slots for agent configuration
- **Interest-Based Discovery**: Query objects the agent is interested in
- **Inter-Agent Communication**: DispatchBus for event-driven agent coordination
- **Graceful Shutdown**: Automatic signal handling (SIGTERM, SIGINT)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Architecture                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│  │ Agent Base  │───▶│ AgentConfig │───▶│  Database   │          │
│  └─────────────┘    └─────────────┘    └─────────────┘          │
│         │                  │                                     │
│         ▼                  ▼                                     │
│  ┌─────────────┐    ┌─────────────┐                             │
│  │  UI Slots   │    │   Export    │──▶ smrt.exported.json       │
│  └─────────────┘    └─────────────┘                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### Agent Base Class (`agent.ts`)

The abstract `Agent` class extends `SmrtObject` and provides the foundation for all autonomous actors.

```typescript
import { Agent, type AgentOptions } from '@happyvertical/smrt-agents';
import { getModuleConfig } from '@happyvertical/smrt-config';
import { smrt } from '@happyvertical/smrt-core';

@smrt()
class MyAgent extends Agent {
  protected config = getModuleConfig('my-agent', {
    cronSchedule: '0 2 * * *',
    maxRetries: 3,
  });

  async run(): Promise<void> {
    this.logger.info('Agent running', { config: this.config });
    // Agent logic here
  }
}

const agent = new MyAgent({ name: 'my-agent' });
await agent.execute();
```

#### Lifecycle Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Setup and initialization. Sets status to 'initializing'. |
| `validate()` | Configuration validation. Override to check requirements. |
| `run()` | Main agent logic. **Must be implemented.** |
| `shutdown()` | Cleanup and graceful shutdown. |
| `execute()` | Full lifecycle execution (initialize → validate → run). |

#### Status Types

```typescript
type AgentStatusType = 'idle' | 'initializing' | 'running' | 'error' | 'shutdown';
```

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `status` | `AgentStatusType` | Current agent status |
| `logger` | `Logger` | Structured logger instance |
| `config` | `unknown` | Agent configuration (must be defined by subclass) |

---

## Configuration Management

### AgentConfig (`config.ts`)

A SmrtObject for persisting agent configuration to the database. Each config record maps to a UI slot for an agent instance.

```typescript
import { AgentConfig, AgentConfigCollection } from '@happyvertical/smrt-agents';

// Create a config record
const config = new AgentConfig({
  agentId: 'agent-123',
  agentClass: 'Praeco',
  slotId: 'sources',
  configData: { scrapers: ['civicweb', 'govstack'] },
  db: options.db,
});
await config.initialize();
await config.save();
```

#### AgentConfig Properties

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | ID of the agent instance this config belongs to |
| `agentClass` | `string` | Class name of the agent (e.g., 'Praeco', 'Caelus') |
| `slotId` | `string` | UI slot ID (e.g., 'sources', 'settings', 'reports') |
| `configData` | `Record<string, any>` | Configuration data stored as JSON |
| `schemaVersion` | `number` | Schema version for future migrations |

#### Static Helper Methods

**`AgentConfig.forAgent(agentId, options)`** - Load all configs for an agent.

```typescript
const configs = await AgentConfig.forAgent('agent-123', { db });
// Returns: Map<slotId, configData>

for (const [slotId, data] of configs) {
  console.log(`${slotId}:`, data);
}
```

**`AgentConfig.forSlot(agentId, slotId, options)`** - Load config for a specific slot.

```typescript
const sourcesConfig = await AgentConfig.forSlot('agent-123', 'sources', { db });
console.log('Sources:', sourcesConfig);
```

**`AgentConfig.saveSlot(data, options)`** - Save or update config for a slot.

```typescript
await AgentConfig.saveSlot({
  agentId: 'agent-123',
  agentClass: 'Praeco',
  slotId: 'sources',
  configData: { scrapers: ['civicweb'] },
}, { db });
```

---

### Agent Config Methods

The Agent base class provides methods for working with configuration.

#### `loadConfigs()`

Load all database-persisted configs for this agent.

```typescript
const configs = await agent.loadConfigs();
const sources = configs.get('sources');
const settings = configs.get('settings');
```

#### `saveSlotConfig(slotId, data)`

Save config for a specific UI slot to the database.

```typescript
await agent.saveSlotConfig('sources', {
  scrapers: ['civicweb', 'govstack'],
  refreshInterval: 3600,
});
```

#### `getMergedConfig(slotId)`

Get merged config for a slot (file-based + database).

**Priority order (highest to lowest):**
1. Database-persisted config (from `saveSlotConfig`)
2. File-based config (from `getModuleConfig`)
3. Agent class defaults

```typescript
const sourcesConfig = await agent.getMergedConfig('sources');
// Returns file config merged with any db overrides
```

#### `exportConfig(options?)`

Export all config for static site generation.

```typescript
// Export for static build (secrets filtered)
const config = await agent.exportConfig();

// Export with secrets (for secure environments)
const fullConfig = await agent.exportConfig({ includeSecrets: true });
```

---

### Config Loading Priority

```
┌─────────────────────────────────────────────────────────────────┐
│                    Config Loading Priority                       │
├─────────────────────────────────────────────────────────────────┤
│  1. Runtime overrides (highest) - via agent methods              │
│  2. Database-persisted config - AgentConfig records              │
│  3. File-based config - smrt.config.js / getModuleConfig()       │
│  4. Agent class defaults (lowest)                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## UI Slot System

Agents declare UI slots that can be implemented as Svelte components for admin panels.

### Declaring UI Slots

```typescript
import { Agent, type AgentUISlots } from '@happyvertical/smrt-agents';
import { smrt } from '@happyvertical/smrt-core';

@smrt()
class Praeco extends Agent {
  static override uiSlots: AgentUISlots = {
    sources: {
      id: 'sources',
      label: 'News Sources',
      description: 'Configure scrapers and data sources',
      icon: 'database',
      order: 1,
    },
    settings: {
      id: 'settings',
      label: 'Agent Settings',
      description: 'Configure agent behavior',
      icon: 'settings',
      order: 2,
    },
    reports: {
      id: 'reports',
      label: 'Reports',
      description: 'View generated reports',
      icon: 'file-text',
      order: 3,
    },
  };

  protected config = getModuleConfig('praeco', {});

  async run(): Promise<void> {
    // Agent logic
  }
}
```

### AgentUISlot Interface

```typescript
interface AgentUISlot {
  id: string;           // Unique identifier (e.g., 'sources', 'settings')
  label: string;        // Human-readable label
  description?: string; // Description of what this panel configures
  icon?: string;        // Icon identifier (e.g., 'settings', 'database')
  order?: number;       // Display order (lower numbers first)
}
```

### Getting UI Slots

```typescript
const slots = agent.getUISlots();

for (const [slotId, slot] of Object.entries(slots)) {
  console.log(`${slot.label}: ${slot.description}`);
}
```

---

## Admin Panel Components

### AdminPanelBaseProps

Base props that all admin panel Svelte components receive.

```typescript
interface AdminPanelBaseProps<TConfig = unknown> {
  /** Current configuration from the agent (merged file + db) */
  config: TConfig;

  /** Callback to save configuration changes */
  onSave: (config: TConfig) => Promise<void>;

  /** Whether the panel is in read-only mode */
  readonly?: boolean;

  /** CSS class for styling integration */
  class?: string;

  /**
   * Read-only file-based configuration defaults (from smrt.config.js)
   * Use this to display which values come from the config file
   */
  fileConfig?: TConfig;

  /**
   * Editable database-persisted configuration overrides
   * Use this to display which values have been customized in the DB
   */
  dbConfig?: TConfig;
}
```

### Implementing a Panel Component

```svelte
<!-- SourcesPanel.svelte -->
<script lang="ts">
  import type { AdminPanelBaseProps } from '@happyvertical/smrt-agents';

  interface SourcesConfig {
    scrapers: string[];
    refreshInterval: number;
  }

  let { config, onSave, readonly, fileConfig, dbConfig }: AdminPanelBaseProps<SourcesConfig> = $props();

  let localConfig = $state({ ...config });

  async function handleSave() {
    await onSave(localConfig);
  }
</script>

<div class="sources-panel">
  <h2>News Sources</h2>

  {#if fileConfig}
    <p class="info">
      Defaults from smrt.config.js: {JSON.stringify(fileConfig)}
    </p>
  {/if}

  <label>
    Scrapers:
    <select multiple bind:value={localConfig.scrapers} disabled={readonly}>
      <option value="civicweb">CivicWeb</option>
      <option value="govstack">GovStack</option>
      <option value="custom">Custom</option>
    </select>
  </label>

  <label>
    Refresh Interval (seconds):
    <input type="number" bind:value={localConfig.refreshInterval} disabled={readonly} />
  </label>

  {#if !readonly}
    <button onclick={handleSave}>Save</button>
  {/if}
</div>
```

### AgentUIRegistry

Global registry for UI component implementations.

```typescript
import { AgentUIRegistry } from '@happyvertical/smrt-agents';
import SourcesPanel from './SourcesPanel.svelte';

// Register component for an agent's slot
AgentUIRegistry.register('Praeco', 'sources', SourcesPanel);

// Get component for rendering
const Component = AgentUIRegistry.get('Praeco', 'sources');

// Check if registered
if (AgentUIRegistry.has('Praeco', 'sources')) {
  // Component is available
}

// Get all registered slots for an agent
const slots = AgentUIRegistry.getSlots('Praeco');
// ['sources', 'settings', 'reports']

// Get all registered agent class names
const agents = AgentUIRegistry.getAgents();
// ['Praeco', 'Caelus', ...]
```

---

## Interest-Based Object Discovery

Agents can declare interests in specific object types and query them with `interesting()`.

### Configuring Interests

```typescript
@smrt()
class NewsAgent extends Agent {
  protected config = getModuleConfig('news-agent', {});

  constructor(options: AgentOptions = {}) {
    super({
      ...options,
      interests: {
        // Global filter applied to all object types
        filter: { status: 'active' },

        // Object-specific configurations
        objects: {
          Meeting: {
            filter: { 'scheduled_at >': new Date() },
            sort: 'scheduled_at DESC',
            limit: 10,
          },
          Document: {
            filter: { 'type in': ['agenda', 'minutes'] },
            handler: async (doc, agent) => {
              return { action: 'summarize', priority: 'high' };
            },
          },
        },

        // Global qualifier (post-filter)
        qualify: async (items) => {
          // Further filter items after database query
          return items.filter(item => item.wordCount > 100);
        },

        // Global sort across all types
        sort: 'created_at DESC',
      },
    });
  }

  async run(): Promise<void> {
    const items = await this.interesting();

    for (const { type, data, name, handled } of items) {
      this.logger.info(`Processing ${type}`, {
        id: data.id,
        name,
        action: handled?.action,
      });
    }
  }
}
```

### InterestResult

```typescript
interface InterestResult {
  type: string;              // Object class name (e.g., 'Meeting')
  data: SmrtObject;          // The actual object instance
  name?: string;             // Filter name (if configured)
  handled?: any;             // Result from handler function
}
```

### Interest Filter Options

```typescript
interface InterestFilter {
  // Name for this filter (for identification)
  name?: string;

  // Standard SDK filter (where clause)
  filter?: Record<string, any>;

  // Custom SQL query function
  query?: (tableName: string) => [whereClause: string, params: any[]];

  // Sort order
  sort?: string | string[];

  // Limit results
  limit?: number;

  // Post-query qualifier
  qualify?: (items: SmrtObject[]) => Promise<SmrtObject[]>;

  // Handler called for each matched item
  handler?: (item: SmrtObject, agent: Agent) => Promise<any>;
}
```

---

## Inter-Agent Communication

Agents can communicate via the DispatchBus.

### Emitting Dispatches

```typescript
async run(): Promise<void> {
  const dispatch = await this.getDispatch();

  // Emit an event
  await dispatch.emit('campaign.completed', {
    campaignId: '123',
    revenue: 5000,
  }, {
    source: this.constructor.name,
  });
}
```

### Subscribing to Dispatches

```typescript
async initialize(): Promise<this> {
  await super.initialize();

  const dispatch = await this.getDispatch();
  await dispatch.subscribe({
    signalType: 'campaign.*',
    subscriber: this.constructor.name,
  });

  return this;
}
```

### Handling Dispatches

```typescript
async handleDispatch(payload: unknown, metadata: DispatchMetadata): Promise<void> {
  if (metadata.type === 'campaign.completed') {
    const data = payload as { campaignId: string; revenue: number };
    await this.recordRevenue(data.campaignId, data.revenue);
  }
}

async run(): Promise<void> {
  // Process all pending dispatches
  const processed = await this.processDispatches();
  this.logger.info(`Processed ${processed} dispatches`);
}
```

---

## Usage Examples

### Complete Agent with Config Persistence

```typescript
import { Agent, type AgentOptions, type AgentUISlots } from '@happyvertical/smrt-agents';
import { getModuleConfig } from '@happyvertical/smrt-config';
import { smrt } from '@happyvertical/smrt-core';

interface PraecoConfig {
  sources?: {
    scrapers: string[];
    refreshInterval: number;
  };
  settings?: {
    maxArticles: number;
    language: string;
  };
}

@smrt({
  tableName: 'praeco_agents',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
class Praeco extends Agent {
  static override uiSlots: AgentUISlots = {
    sources: {
      id: 'sources',
      label: 'News Sources',
      description: 'Configure scrapers and data sources',
      icon: 'database',
      order: 1,
    },
    settings: {
      id: 'settings',
      label: 'Agent Settings',
      description: 'Configure agent behavior',
      icon: 'settings',
      order: 2,
    },
  };

  protected config: PraecoConfig = getModuleConfig('praeco', {
    sources: {
      scrapers: ['civicweb'],
      refreshInterval: 3600,
    },
    settings: {
      maxArticles: 100,
      language: 'en',
    },
  });

  async run(): Promise<void> {
    // Get merged config (file + db)
    const sources = await this.getMergedConfig('sources');
    const settings = await this.getMergedConfig('settings');

    this.logger.info('Running with config', { sources, settings });

    // Process scrapers
    for (const scraper of sources.scrapers) {
      await this.runScraper(scraper);
    }
  }

  private async runScraper(scraper: string): Promise<void> {
    this.logger.info(`Running scraper: ${scraper}`);
    // Scraper logic
  }
}

// Usage
const agent = new Praeco({
  name: 'praeco-main',
  db: { type: 'sqlite', url: './data/praeco.db' },
});

await agent.execute();
```

### Host Application Integration

```typescript
// +page.server.ts (SvelteKit)
import { Praeco } from '@happyvertical/praeco';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const agent = await Praeco.get(params.agentId);

  // Get UI slots for rendering admin panels
  const slots = agent.getUISlots();

  // Load current configs for each slot
  const configs: Record<string, any> = {};
  for (const slotId of Object.keys(slots)) {
    configs[slotId] = await agent.getMergedConfig(slotId);
  }

  return { agent, slots, configs };
};

export const actions: Actions = {
  saveConfig: async ({ request, params }) => {
    const agent = await Praeco.get(params.agentId);
    const formData = await request.formData();

    const slotId = formData.get('slotId') as string;
    const configData = JSON.parse(formData.get('config') as string);

    // Save to database
    await agent.saveSlotConfig(slotId, configData);

    return { success: true };
  },
};
```

### Static Site Export

```bash
# Export agent config before static build (JS format for compatibility)
smrt config:export --agent praeco-main --format js --output smrt.exported.js

# Build static site
npm run build
```

```javascript
// smrt.config.js - use JS export for maximum compatibility
import exported from './smrt.exported.js';

export default {
  modules: {
    praeco: {
      ...exported,
      // Environment-specific overrides
      apiEndpoint: process.env.API_URL,
    },
  },
};
```

---

## Package Exports

```typescript
// Core agent
export { Agent, type AgentOptions } from './agent.js';

// Configuration
export { AgentConfig, AgentConfigCollection } from './config.js';

// Types
export type { AgentStatusType } from './types.js';

// Interests
export type {
  AgentWithInterestsOptions,
  AsyncQualifierFn,
  InterestFilter,
  InterestHandlerFn,
  InterestOptions,
  InterestResult,
  ObjectFilter,
  ObjectInterestConfig,
  QueryFn,
} from './interests.js';
export { mergeFilters, normalizeSort } from './interests.js';

// UI
export {
  AgentUIRegistry,
  createUIRegistry,
  type AdminPanelBaseProps,
  type AgentUIComponentRegistry,
  type AgentUISlot,
  type AgentUISlots,
  type ComponentType,
} from './ui.js';
```

---

## Testing

### Unit Test Examples

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Agent, AgentConfig } from '@happyvertical/smrt-agents';
import { smrt } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';

@smrt()
class TestAgent extends Agent {
  protected config = { testValue: 'default' };

  async run(): Promise<void> {
    this.logger.info('Test agent running');
  }
}

describe('Agent', () => {
  let db: any;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('should execute lifecycle', async () => {
    const agent = new TestAgent({ name: 'test', db });
    await agent.execute();
    expect(agent.status).toBe('idle');
  });

  it('should save and load config', async () => {
    const agent = new TestAgent({ name: 'test', db });
    await agent.initialize();

    await agent.saveSlotConfig('settings', { key: 'value' });

    const config = await agent.getMergedConfig('settings');
    expect(config.key).toBe('value');
  });

  it('should export config without secrets', async () => {
    const agent = new TestAgent({ name: 'test', db });
    await agent.initialize();

    await agent.saveSlotConfig('settings', {
      apiKey: 'secret-key',
      name: 'test',
    });

    const exported = await agent.exportConfig();
    expect(exported.settings.name).toBe('test');
    expect(exported.settings.apiKey).toBe('[REDACTED]');
  });
});

describe('AgentConfig', () => {
  let db: any;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('should save and retrieve config', async () => {
    await AgentConfig.saveSlot({
      agentId: 'agent-1',
      agentClass: 'TestAgent',
      slotId: 'sources',
      configData: { scrapers: ['test'] },
    }, { db });

    const config = await AgentConfig.forSlot('agent-1', 'sources', { db });
    expect(config.scrapers).toEqual(['test']);
  });

  it('should load all configs for agent', async () => {
    await AgentConfig.saveSlot({
      agentId: 'agent-1',
      agentClass: 'TestAgent',
      slotId: 'sources',
      configData: { scrapers: ['test'] },
    }, { db });

    await AgentConfig.saveSlot({
      agentId: 'agent-1',
      agentClass: 'TestAgent',
      slotId: 'settings',
      configData: { maxItems: 100 },
    }, { db });

    const configs = await AgentConfig.forAgent('agent-1', { db });
    expect(configs.size).toBe(2);
    expect(configs.get('sources').scrapers).toEqual(['test']);
    expect(configs.get('settings').maxItems).toBe(100);
  });
});
```

---

## Common Patterns

### 1. Agent with Multiple Data Sources

```typescript
@smrt()
class MultiSourceAgent extends Agent {
  protected config = getModuleConfig('multi-source', {
    sources: {
      api: { url: 'https://api.example.com' },
      database: { connectionString: process.env.DB_URL },
      files: { directory: './data' },
    },
  });

  async run(): Promise<void> {
    const sources = await this.getMergedConfig('sources');

    // Process each source type
    await this.processApiSource(sources.api);
    await this.processDatabaseSource(sources.database);
    await this.processFileSource(sources.files);
  }
}
```

### 2. Scheduled Agent with State

```typescript
@smrt()
class ScheduledAgent extends Agent {
  protected config = getModuleConfig('scheduled', {
    cronSchedule: '0 0 * * *',
  });

  // Persisted state
  lastRun: Date | null = null;
  itemsProcessed: number = 0;

  async run(): Promise<void> {
    const items = await this.fetchItems();

    for (const item of items) {
      await this.processItem(item);
      this.itemsProcessed++;
    }

    this.lastRun = new Date();
    await this.save(); // Persist state to database
  }
}
```

### 3. Agent with Admin Panel

```typescript
// agent.ts
@smrt()
class ConfigurableAgent extends Agent {
  static override uiSlots: AgentUISlots = {
    settings: {
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      order: 1,
    },
  };

  protected config = getModuleConfig('configurable', {
    settings: { enabled: true, limit: 100 },
  });

  async run(): Promise<void> {
    const settings = await this.getMergedConfig('settings');
    if (!settings.enabled) {
      this.logger.info('Agent disabled, skipping');
      return;
    }
    // Run with settings.limit
  }
}

// admin/SettingsPanel.svelte
<script lang="ts">
  import type { AdminPanelBaseProps } from '@happyvertical/smrt-agents';
  import { AgentUIRegistry } from '@happyvertical/smrt-agents';

  let { config, onSave, fileConfig } = $props();
</script>

// Register on import
AgentUIRegistry.register('ConfigurableAgent', 'settings', SettingsPanel);
```

---

## Troubleshooting

### Agent has no interests configured

```
Error: Agent MyAgent has no interests configured.
```

**Solution**: Pass interests in constructor options:
```typescript
super({
  ...options,
  interests: {
    objects: { Meeting: { limit: 10 } },
  },
});
```

### Database required for dispatch

```
Error: Agent MyAgent requires database configuration for dispatch.
```

**Solution**: Initialize agent with database:
```typescript
const agent = new MyAgent({
  name: 'my-agent',
  db: { type: 'sqlite', url: './data/app.db' },
});
```

### Config not persisting

**Solution**: Ensure you call `saveSlotConfig()` and have a valid database:
```typescript
await agent.initialize(); // Must be initialized first
await agent.saveSlotConfig('settings', { key: 'value' });
```

---

## Related Packages

- **@happyvertical/smrt-core**: Base SmrtObject and ObjectRegistry
- **@happyvertical/smrt-config**: Configuration loading and export utilities
- **@happyvertical/smrt-cli**: `config:export` command
- **@happyvertical/logger**: Structured logging

## License

MIT License - see [LICENSE](../../LICENSE) file for details.
