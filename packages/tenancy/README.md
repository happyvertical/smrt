# @happyvertical/smrt-tenancy

Multi-tenancy for SMRT with AsyncLocalStorage context propagation, automatic query filtering, and tenant ID population.

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
