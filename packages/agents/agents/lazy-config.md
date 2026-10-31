# Lazy agent_config resolution (#1161, #2806)

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

**Resolver context and precedence (#2806).** Every resolver receives a frozen `ConfigResolverContext`. It holds this instance's `agentId` (the job's `objectId`), canonical `agentClass`, `tenantId`, `scheduleId` and `jobId`. Class resolvers also get the instance's own persisted value for the key (`persisted`, `hasPersisted`); sentinel resolvers get the value's `path`. Precedence:
1. a non-null resolver result;
2. the persisted value, kept on `undefined` / `null`;
3. absent.

A deployment fallback that must not clobber an agent's own value, such as its provider credential, uses `preferPersisted(fallback)` or returns `undefined` when `context.hasPersisted`. Never select an agent by scanning the tenant's `agent_configs` rows: with several agents of one class per tenant, that leaks one agent's credential to another. Use `context.agentId`. Zero-argument resolvers remain valid.
