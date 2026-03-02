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

Mismatches throw `TenantIsolationError`. Missing required context throws `TenantContextError`.

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
