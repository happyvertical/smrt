# @happyvertical/smrt-tenancy

Multi-tenancy for s-m-r-t with AsyncLocalStorage context propagation, automatic query filtering, and tenant ID population.

## Installation

```bash
pnpm install @happyvertical/smrt-tenancy
```

## Usage

```typescript
import { enableTenancy, TenantScoped, tenantId, withTenant } from '@happyvertical/smrt-tenancy';
import { smrt, SmrtObject } from '@happyvertical/smrt-core';

// 1. Enable tenancy globally (once at app startup)
enableTenancy();

// 2. Mark classes as tenant-scoped
@smrt()
@TenantScoped({ mode: 'optional' })
class Document extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  title: string = '';
}

// 3. Wrap operations in tenant context
await withTenant({ tenantId: 'tenant-123' }, async () => {
  const docs = await collection.list({ where: { status: 'active' } });
  // Executes: WHERE tenant_id = 'tenant-123' AND status = 'active'
});
```

## API

### Billing relationships

Billing parentage is separate from the `@happyvertical/smrt-users` tenant
hierarchy. Reassigning a reseller or changing who pays does not reparent the
tenant for permissions and does not move its records. A tenant with no billing
relationship is self-billed. Each child has at most one relationship; its
`billingOwnerMode` is `self` or `reseller`, and the owner is derived from that
single row. Tenant UUIDs are normalized to lowercase before storage and lookup.
A reseller can therefore manage a child that pays for itself.

```typescript
import {
  BillingRelationshipService,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';

const billing = await BillingRelationshipService.create({
  db,
  // Resolve IDs against the application's tenant directory (for example,
  // smrt-users TenantCollection). The tenancy package does not own Tenant.
  tenantExists: async (id) => Boolean(await tenants.get({ id })),
});

await withSystemContext(() =>
  billing.setRelationship({
    childTenantId: childId,
    resellerTenantId: resellerId,
    billingOwnerMode: 'reseller',
  }),
);

const ownerId = await withSystemContext(() =>
  billing.resolveBillingOwner(childId),
);
const billedChildren = await withSystemContext(() =>
  billing.listChildrenBilledTo(ownerId),
);
```

`setRelationship()` changes parentage and the default owner together in a
transaction. Setting `billingOwnerMode: 'self'` keeps reseller parentage while
making the child pay for itself. `clearRelationship()` removes parentage and
returns the child to self-billing. Cycles and self-parenting are rejected.
Relationship changes are serialized on supported SQL adapters; PostgreSQL
uses an advisory transaction lock. Local SQLite, DuckDB, and PostgreSQL are
supported; remote LibSQL is rejected because its writers cannot share the
in-process graph lock. The new `_smrt_billing_relationships` table
must be applied through the normal `smrt db:migrate` deployment flow.

Generated API, MCP, and CLI mutation surfaces for these rows are disabled.
`BillingRelationship` is a root export only because SMRT consumer registration
imports every published manifest model from the package root; saving it
directly bypasses the service's tenant, cycle, and authorization checks.
`BillingRelationshipCollection` is not exported. Callers use the service.
Without an `authorize` callback, mutations require explicit system context.
Reads are limited to the child, its reseller, or system context; a host may
provide `authorize` for additional permission-checked access. Supply a tenant
resolver that does not depend on the caller's current tenant scope when the
operation intentionally crosses tenants, and enforce actor permissions in the
host callback before allowing relationship changes.

### Decorators

| Export | Description |
|--------|-------------|
| `TenantScoped(options?)` | Class decorator. Modes: `'required'` (default) or `'optional'` |
| `tenantId(options?)` | Property decorator for the tenant ID field |

### Context Runners

| Export | Description |
|--------|-------------|
| `withTenant(ctx, fn)` | Run code scoped to a tenant |
| `withTenantSync(ctx, fn)` | Synchronous variant |
| `withSystemContext(fn)` | Bypass all tenant checks (admin/migrations) |
| `withSuperAdminBypass(fn)` | Keep tenant context but disable auto-filtering |
| `enterTenantContext(ctx)` | Enter context without callback (for middleware) |

### Context Accessors

| Export | Description |
|--------|-------------|
| `getCurrentTenant()` | Get current tenant context (may be undefined) |
| `getTenantId()` | Get tenant ID string (may be undefined) |
| `requireTenant()` | Get tenant context or throw |
| `requireTenantId()` | Get tenant ID or throw |
| `hasTenantContext()` | Check if in tenant context |
| `isSystemContext()` | Check if in system context |
| `isSuperAdminBypass()` | Check if super admin bypass is active |
| `TenantContext` | AsyncLocalStorage instance (advanced use) |

### Errors

`TenantContextError` (missing required context), `TenantIsolationError` (tenant mismatch).

### Interceptor

| Export | Description |
|--------|-------------|
| `enableTenancy()` | Register tenant interceptor globally |
| `disableTenancy()` | Remove tenant interceptor |
| `isTenancyEnabled()` | Check if tenancy is active |
| `createTenantInterceptor(options?)` | Create interceptor manually |

### Framework Adapters

| Export | Description |
|--------|-------------|
| `createSvelteKitHandle(options)` | SvelteKit hooks.server.ts handler |
| `createExpressMiddleware(options)` | Express middleware |
| `createCliContext(options)` | CLI context with `run()`, `runWithTenant()`, `runAsSystem()` |

### Registry (Advanced)

| Export | Description |
|--------|-------------|
| `isTenantScopedClass(name)` | Check if a class is tenant-scoped |
| `getTenantScopedConfig(name)` | Get tenant config for a class |
| `getAllTenantScopedClasses()` | List all registered tenant-scoped classes |
| `registerTenantScopedClass()` | Register a class programmatically |
| `unregisterTenantScopedClass()` | Remove a class from registry |
| `clearTenantScopedRegistry()` | Clear all registrations |

### Testing

| Export | Description |
|--------|-------------|
| `setupTestTenancy(options?)` | Enable tenancy for tests |
| `resetTenancy()` | Clean up tenancy state between tests |
| `createTestTenantContext(ctx, fn)` | Run test code in tenant context |
| `testTenantIsolation(tenantIds, fn)` | Verify isolation between tenants |
| `assertTenantContextRequired(fn)` | Assert operation requires context |
| `assertTenantIsolationViolation(fn)` | Assert operation violates isolation |

## Dependencies

- `@happyvertical/smrt-core` -- SmrtObject, SmrtCollection, GlobalInterceptors
- `@happyvertical/sql` -- database operations
- `@happyvertical/utils` -- utility functions

Optional peers: `svelte`, `@happyvertical/smrt-users`, `@happyvertical/smrt-svelte`

## License

MIT

### Authorized tenant/global list reads

`withTenantGlobalRead(tenantId, callback)` permits list-family reads of the named
tenant plus global rows after validating the caller's tenant. It preserves the
original actor, permissions, and system status for business interceptors; it does
not turn ordinary callers into system callers. The built-in tenancy `beforeList`
hook ANDs this scope into every existing predicate branch, and rechecks identity
if nested code changes tenants. Point reads, raw queries, and writes retain their
normal guards. The capability is async-local, restores after exceptions, and does
not affect concurrent requests. Real system/super-admin callers retain their
existing bypass behavior. Use bounded collection reads inside the callback.
