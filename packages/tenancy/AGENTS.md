# @happyvertical/smrt-tenancy

Multi-tenancy via AsyncLocalStorage context propagation with automatic query filtering and tenant ID population.

## Context Propagation

```typescript
import { withTenant, getTenantId, withSystemContext } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-123' }, async () => {
  // All SmrtCollection queries auto-filtered by tenantId
  // All creates auto-populate tenantId
  const docs = await collection.list({}); // WHERE tenant_id = 'tenant-123'
});

await withSystemContext(async () => { /* bypasses all tenant checks */ });
```

**Critical distinction**: `withSystemContext()` sets a SYSTEM_CONTEXT_MARKER sentinel — different from "no context" (undefined). Interceptor can distinguish intentional bypass from missing context.

## Interceptor System

Hooks into SmrtCollection via `GlobalInterceptors.register()` (priority 100, runs first):

| Hook | Behavior |
|------|----------|
| `beforeList` | Injects `tenantId` into WHERE clause; validates existing filters match context |
| `beforeGet` | Same — converts ID lookup to `{ id, tenantId }` |
| `beforeSave` | Auto-populates tenantId if empty + `autoPopulate: true`; validates if already set |
| `beforeDelete` | Validates instance.tenantId matches context |
| `beforeQuery` | Enforces raw SQL policy on tenant-scoped classes (`throw`/`warn`/`allow`) |
| `afterSave` | Emits `directory.<class>.created`/`updated` via `dispatchBus` for configured `directoryClasses` |
| `afterDelete` | Emits `directory.<class>.deleted` via `dispatchBus` for configured `directoryClasses` |

Mismatches throw `TenantIsolationError`. Missing required context throws `TenantContextError`.

**Optional-mode reads with no context pass through UNFILTERED at the interceptor.** That is intentional for trusted/admin call paths, but it means the interceptor alone does not protect a tenant-scoped model exposed as `@smrt({ api: { public } })`: an anonymous HTTP read has no context, so the interceptor would return every tenant's rows. The generated REST + SvelteKit read routes close this by injecting a `{ tenantId: null }` filter when tenancy is enabled but no context is active, so public/anonymous reads fail closed to **global (NULL-tenant) rows only** — mirroring the dispatch resolver's *enforced, no active tenant → global rows only* rule (#1782). Authenticated reads still scope to the caller's tenant via the interceptor.

## Registration — Two Patterns

```typescript
// Pattern 1: Tenancy decorator
@TenantScoped({ mode: 'optional' })
class Doc extends SmrtObject { @tenantId({ nullable: true }) tenantId: string | null = null; }

// Pattern 2: Core decorator (tenancy package reads this too)
@smrt({ tenantScoped: { mode: 'optional' } })
class Doc extends SmrtObject { tenantId: string | null = null; }
```

Modes: `'required'` (default — throws without context) or `'optional'` (passes through if no context).

## Adapters

- **Express**: `createExpressMiddleware()` — uses `enterTenantContext()` (not withTenant, because middleware returns before handlers run)
- **SvelteKit**: `createSvelteKitHandle()` — stores context in `event.locals`
- **CLI**: `createCliContext()` — `run()`, `runWithTenant()`, `runAsSystem()`, `runAsSuperAdmin()`

## Super Admin Bypass

`withSuperAdminBypass()` keeps tenant context but disables auto-filtering. Different from `withSystemContext()` which removes context entirely.

## Gotchas

- **Context lost in callbacks**: `setTimeout(() => getTenantId(), 100)` → undefined. Fix: `TenantContext.bind(fn)`
- **Nested contexts override**: inner `withTenant()` overrides outer; restores on exit
- **Auto-populate only if empty**: if tenantId already set, interceptor validates (not overwrites)
- **Isolation checked at query time**: `list({ where: { tenantId: 'other' } })` throws immediately
- **Testing**: `resetTenancy()` + `setupTestTenancy()` in beforeEach; `testTenantIsolation()` helper

## Known exceptions to monorepo standards

- **`serializeInstance()` in `src/interceptor.ts` calls `instance.toJSON()` directly** (standards.md §7 forbids this in favor of `transformJSON()`). The interceptor must serialize arbitrary instances handed to it — including workspace stubs and plain-object test doubles whose classes may not extend `SmrtObject` and therefore have no `transformJSON()` hook. The call is duck-typed and falls back to manual key iteration when `toJSON` is absent. See the inline comment at the call site for the full rationale.
