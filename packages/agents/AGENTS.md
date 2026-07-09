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

## Learning Trait (issue #1886) — opt-in

Any agent can opt into a confidence-scored **recall-before / capture-after** loop backed by core's `LearningMemory` (over `_smrt_contexts` + `_smrt_embeddings`). **Off by default** — a non-opted agent behaves byte-for-byte as today; the lifecycle's learning branches are never entered.

```typescript
@smrt()
class InvoiceAgent extends Agent {
  static override learning = true; // or { minConfidence: 0.8, scope: 'invoices', ... }
  protected config = {};

  async run() {
    // recall-before-run already populated `recalledMemories` (confidence >= floor)
    const cached = this.recalledMemories.find((m) => m.key === this.docUrl);
    const strategy = cached?.value ?? (await this.generateStrategy());

    // stage the episode; the lifecycle reinforces it after run()
    this.stageLearning({ scope: this.learningScope(), key: this.docUrl, value: strategy });

    // a validated failure decays the memory without throwing
    if (!ok) this.reportLearningOutcome({ success: false, error: 'no match' });
  }
}
```

- **`capture` semantics** (`LearningMemory`): success strengthens `confidence` toward 1.0 and increments `success_count`; failure decays toward `failureConfidence` (0.3) and increments `failure_count`. A single failure drops a confident memory below the reuse floor (0.7), so recall stops returning it. Refreshes `last_used_at`; honours `expires_at` and optional time-decay.
- **Memory isolation**: bound to `(agentType, agentInstanceId)` as `(owner_class, owner_id)`, so two tenants on the same agent class never share memory. `tenantId` is threaded into the optional semantic-search `where`.
- **Seams to override**: `learningScope()`, `recallForRun(memory)`, `captureForRun(memory, outcome)`, `getLearningSemanticSearch()`. Helpers for `run()`: `stageLearning(episode)`, `reportLearningOutcome(outcome)`, `getLearningMemory()`, and the `recalledMemories` field.
- **Config**: `static learning: boolean | AgentLearningConfig` — `{ enabled?, scope?, minConfidence?, successConfidence?, failureConfidence?, reinforcement?, decayHalfLifeMs? }`. `LearningMemory` and its types are re-exported from `@happyvertical/smrt-core`.

## Key Files

| File | Purpose |
|------|---------|
| `src/agent.ts` | Base Agent class — lifecycle, dispatch, interests, config, opt-in learning trait |
| `src/learning.ts` | `AgentLearningConfig` + `resolveAgentLearning()` declaration normalisation |
| `src/schedule.ts` | AgentSchedule model — cron, execution tracking |
| `src/tenant-agent.ts` | TenantAgent — junction table, hierarchical resolution |
| `src/interests.ts` | Interest filter types and configuration |
| `src/config.ts` | File + DB config management, UI slots |
