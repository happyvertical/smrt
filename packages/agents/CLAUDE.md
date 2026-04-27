# @happyvertical/smrt-agents

Agent framework for autonomous actors with inter-agent messaging, interest-based object discovery, scheduling, and multi-tenant bindings.

## Agent Lifecycle

`initialize()` → `validate()` → `run()` → `shutdown()`

- Extend `Agent` (which extends `SmrtObject`) and implement `run()`
- Status tracking: `idle → initializing → running → error/shutdown`
- `execute()` runs the full lifecycle automatically
- Process signal handling is opt-in via `manageProcessSignals: true` and is intended for single-agent processes

## DispatchBus — Inter-Agent Communication

Agents communicate via persistent async messaging through core's DispatchBus:

```typescript
// Emitting (in any agent)
const bus = await this.getDispatch();
await bus.emit('campaign.completed', { campaignId: '123' }, { source: 'Suasor' });

// Subscribing (in receiving agent)
async handleDispatch(payload: unknown, metadata: DispatchMetadata): Promise<void> {
  if (metadata.type === 'campaign.completed') await this.recordRevenue(payload);
}
async run() { await this.processDispatches(); } // processes via handleDispatch()
```

CLI: `smrt dispatch:list`, `dispatch:process --subscriber Fiscus`, `dispatch:retry`, `dispatch:cleanup`

## Interests — Object Discovery

Agents query objects they care about via declarative filters:

```typescript
constructor(options) {
  super({ ...options, interests: {
    objects: { Meeting: { filter: { status: 'upcoming' }, handler: async (m) => ({ action: 'recap' }) } },
    qualify: async (items) => items.filter(/* AI-based post-filter */),
  }});
}
async run() { for (const { type, data } of await this.interesting()) { ... } }
```

## Configuration

- **File-based**: `getModuleConfig('agent-name', defaults)` from `smrt.config.ts`
- **DB-persisted**: `saveSlotConfig(slotId, data)` for UI overrides
- **Merged**: `getMergedConfig('slotId')` — DB overrides file config
- **UI slots**: `static uiSlots` declares admin panels (id, label, icon, order)

## TenantAgent — Multi-Tenant Bindings

Junction table (`tenant_agents`) binding agents to tenants with permission overrides and hierarchy resolution:
- Explicit binding: row exists for tenant (source: 'explicit')
- Inherited: walks up tenant hierarchy (source: 'inherited')
- Permissions: manifest defaults merged with per-tenant overrides

## AgentSchedule

Cron-based scheduling stored in `_smrt_agent_schedules`. Fields: `agentType`, `cron`, `method` (default: 'run'), `maxConcurrent`, `timeout`. Executed by ScheduleRunner from smrt-jobs.

## Lazy agent_config Resolution (issue #1161)

Persisted `agent_config` snapshots env-derived values at sync time, so rotated env vars don't reach already-stored schedule rows. Two complementary mechanisms unfreeze them:

1. **`$env` sentinels in persisted config** — register a global resolver and reference it from the JSON:

   ```ts
   import { registerConfigResolver } from '@happyvertical/smrt-agents';
   registerConfigResolver('sharedAssetStorage', () => resolveSharedAssetStorage());
   // persisted: { "assetStorage": { "$env": "sharedAssetStorage" } }
   ```

2. **`static configResolvers` on the agent class** — declarative, discoverable via the class itself:

   ```ts
   class Praeco extends Agent {
     static override configResolvers = {
       assetStorage: () => resolveSharedAssetStorage(),
     };
   }
   ```

The TaskRunner calls `resolveLazyConfig()` immediately before constructing the agent, so live values always win over snapshotted ones. Re-exported from `@happyvertical/smrt-core` (`resolveLazyConfig`, `registerConfigResolver`, `getClassConfigResolvers`, …) for cases where agents isn't on the import path.

## Key Files

| File | Purpose |
|------|---------|
| `src/agent.ts` | Base Agent class — lifecycle, dispatch, interests, config |
| `src/schedule.ts` | AgentSchedule model — cron, execution tracking |
| `src/tenant-agent.ts` | TenantAgent — junction table, hierarchical resolution |
| `src/interests.ts` | Interest filter types and configuration |
| `src/config.ts` | File + DB config management, UI slots |
