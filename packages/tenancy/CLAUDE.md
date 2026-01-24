# @happyvertical/smrt-tenancy: Multi-Tenant Data Isolation

## Purpose

The `@happyvertical/smrt-tenancy` package provides automatic tenant-scoped data isolation for SMRT applications. It enables you to build multi-tenant applications where data is automatically filtered and scoped by tenant without manual intervention.

## Key Features

✅ **Auto-filtering**: Queries automatically filtered by current tenant
✅ **Auto-population**: `tenantId` automatically injected when creating/saving objects
✅ **Async Context**: AsyncLocalStorage-based context propagation (no explicit passing)
✅ **Middleware Support**: Express, SvelteKit, and custom middleware adapters
✅ **Super Admin Bypass**: Optional cross-tenant operations for admin users
✅ **Testing Helpers**: Easy tenant context setup for tests

## Quick Start

### 1. Install Package

```bash
npm install @happyvertical/smrt-tenancy
```

### 2. Define Tenant-Scoped Classes

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ tenantScoped: true })
class Document extends SmrtObject {
  title: string = '';
  content: string = '';
  // tenantId field auto-injected by decorator
}
```

### 3. Enable Tenancy at Startup

```typescript
import { enableTenancy } from '@happyvertical/smrt-tenancy';

// Call once at application startup
enableTenancy();
```

### 4. Use Within Tenant Context

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-123' }, async () => {
  // Auto-population - no manual tenantId needed!
  const doc = await collection.create({
    title: 'My Document',
    content: 'Hello World',
    // tenantId automatically set to 'tenant-123'
  });

  // Auto-filtering - only sees tenant-123's documents
  const docs = await collection.list({});
  // All docs have tenantId === 'tenant-123'
});
```

## Configuration Options

### Decorator Config

```typescript
@smrt({
  tenantScoped: {
    mode: 'required',              // 'required' | 'optional'
    field: 'tenantId',             // Custom field name
    autoFilter: true,              // Auto-filter queries by tenant
    autoPopulate: true,            // Auto-populate tenantId on save
    allowSuperAdminBypass: false,  // Allow cross-tenant operations
  }
})
class MyClass extends SmrtObject {
  // ...
}

// Shorthand (uses all defaults):
@smrt({ tenantScoped: true })
class MyClass extends SmrtObject {}
```

### Interceptor Config

```typescript
import { enableTenancy } from '@happyvertical/smrt-tenancy';

enableTenancy({
  rawQueryPolicy: 'throw',  // 'throw' | 'warn' | 'allow'

  // Optional callbacks for monitoring
  onMissingContext: (className, operation) => {
    console.error(`Missing tenant context for ${operation} on ${className}`);
  },

  onIsolationViolation: (className, expectedTenantId, actualTenantId) => {
    console.error(`Tenant isolation violated: ${className}`);
  },
});
```

## Tenant Context Management

### AsyncLocalStorage-Based Context

The package uses Node.js AsyncLocalStorage for automatic context propagation:

```typescript
import { withTenant, getCurrentTenant, getTenantId } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-123' }, async () => {
  // Context available throughout async call stack
  const id = getTenantId(); // 'tenant-123'
  const ctx = getCurrentTenant(); // { tenantId: 'tenant-123', permissions: Set(...) }

  await someAsyncFunction(); // Context still available
});
```

### Middleware Integration

#### Express

```typescript
import { enterTenantContext } from '@happyvertical/smrt-tenancy';

// ⚠️ IMPORTANT: tenantId must come from authenticated user state,
// NOT from client-controlled headers or cookies!
app.use((req, res, next) => {
  // Assumes an upstream authentication middleware has populated req.user
  // from a verified token or session, and that req.user.tenantId is trusted
  // server-side state.
  const user = (req as any).user;
  const tenantId = user?.tenantId as string | undefined;

  if (tenantId) {
    enterTenantContext({ tenantId });
  }
  next();
});
```

#### SvelteKit

```typescript
import { enterTenantContext } from '@happyvertical/smrt-tenancy';

// ⚠️ IMPORTANT: tenantId must come from authenticated session data,
// NOT from client-controlled cookies!
export const handle = async ({ event, resolve }) => {
  // Assumes an upstream authentication hook has populated event.locals.user
  // from a verified session or token, and that user.tenantId is trusted
  // server-side state.
  const user = event.locals.user;
  const tenantId = user?.tenantId as string | undefined;

  if (tenantId) {
    enterTenantContext({ tenantId });
  }
  return resolve(event);
};
```

### Testing

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';
import { beforeEach, it, expect } from 'vitest';

describe('Document', () => {
  beforeEach(async () => {
    enableTenancy();
  });

  it('should auto-populate tenantId', async () => {
    await withTenant({ tenantId: 'test-tenant' }, async () => {
      const doc = await collection.create({
        title: 'Test',
      });
      expect(doc.tenantId).toBe('test-tenant');
    });
  });
});
```

## Auto-Population Feature (Issue #809)

### How It Works

When you use `@smrt({ tenantScoped: true })`, the package:

1. **Registers** the class with tenant scoping config in ObjectRegistry
2. **Intercepts** all `save()` operations via `beforeSave` hook
3. **Checks** if `tenantId` is missing on the instance
4. **Injects** `tenantId` from the current AsyncLocalStorage context

### Usage Example

```typescript
@smrt({ tenantScoped: true })
class Build extends SmrtObject {
  contractId: string = '';
  status: string = '';
}

// In your application code
await withTenant({ tenantId: 'tenant-abc' }, async () => {
  // ✅ BEFORE (manual - tedious)
  const build = await collection.create({
    contractId: 'contract-123',
    status: 'pending',
    tenantId: 'tenant-abc',  // Had to provide manually
  });

  // ✅ AFTER (auto - clean)
  const build = await collection.create({
    contractId: 'contract-123',
    status: 'pending',
    // tenantId auto-populated!
  });
});
```

### Common Mistakes

#### ❌ Forgetting to Enable Tenancy

```typescript
// Missing enableTenancy() call!
await withTenant({ tenantId: 'test' }, async () => {
  const doc = await collection.create({ title: 'Test' });
  // tenantId NOT auto-populated - no interceptor registered
});
```

**Solution**: Call `enableTenancy()` at app startup.

#### ❌ Not Using withTenant Context

```typescript
enableTenancy();

// Missing withTenant() wrapper!
const doc = await collection.create({
  title: 'Test',
  tenantId: TEST_TENANT_ID,  // Still manual!
});
```

**Solution**: Wrap operations in `withTenant()`.

#### ❌ Overriding Auto-Populated Value

```typescript
await withTenant({ tenantId: 'tenant-123' }, async () => {
  const doc = await collection.create({
    title: 'Test',
    tenantId: 'different-tenant',  // ⚠️ Throws TenantIsolationError!
  });
});
```

**Solution**: Don't provide `tenantId` explicitly - let it auto-populate.

## Super Admin Bypass

For administrative operations that need cross-tenant access:

```typescript
import { withSuperAdminBypass, getTenantId } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'admin-tenant' }, async () => {
  // Regular tenant context
  getTenantId(); // 'admin-tenant'

  await withSuperAdminBypass(async () => {
    // Bypass enabled - can see all tenants
    const allDocs = await collection.list({});
    // Returns documents from ALL tenants
  });
});
```

## System Context (No Tenant)

For migrations, background jobs, or system operations:

```typescript
import { withSystemContext } from '@happyvertical/smrt-tenancy';

await withSystemContext(async () => {
  // No tenant context - all tenant checks disabled
  const allData = await collection.list({});
});
```

## Error Handling

### TenantContextError

Thrown when tenant context is required but missing:

```typescript
import { TenantContextError } from '@happyvertical/smrt-tenancy';

try {
  // No tenant context!
  const doc = await collection.create({ title: 'Test' });
} catch (error) {
  if (error instanceof TenantContextError) {
    console.error('Missing tenant context:', error.message);
  }
}
```

### TenantIsolationError

Thrown when attempting cross-tenant operations:

```typescript
import { TenantIsolationError } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-123' }, async () => {
  try {
    // Trying to create with different tenant!
    await collection.create({
      title: 'Test',
      tenantId: 'different-tenant',
    });
  } catch (error) {
    if (error instanceof TenantIsolationError) {
      console.error('Tenant mismatch:', error.message);
    }
  }
});
```

## Advanced Features

### Custom Tenant Field Name

```typescript
@smrt({
  tenantScoped: {
    field: 'organizationId',  // Use custom field name
  }
})
class User extends SmrtObject {
  name: string = '';
  // organizationId auto-injected instead of tenantId
}
```

### Optional Tenancy

```typescript
@smrt({
  tenantScoped: {
    mode: 'optional',  // Works with or without tenant context
  }
})
class AuditLog extends SmrtObject {
  message: string = '';
  // Can be created without tenant context
}
```

### Raw SQL on Tenant-Scoped Classes

By default, raw SQL queries are blocked on tenant-scoped classes:

```typescript
// ❌ Throws TenantIsolationError
await collection.query('SELECT * FROM documents WHERE status = ?', ['active']);

// ✅ Allow with explicit flag
await collection.query(
  'SELECT * FROM documents WHERE tenant_id = ? AND status = ?',
  ['tenant-123', 'active'],
  { allowRawOnTenantScoped: true }
);
```

## Best Practices

### 1. Enable Tenancy Early

```typescript
// At application entry point (before any database operations)
import { enableTenancy } from '@happyvertical/smrt-tenancy';

enableTenancy();
```

### 2. Use Middleware for Web Apps

```typescript
// Establish tenant context at the HTTP boundary
app.use((req, res, next) => {
  const tenantId = extractTenantId(req); // Your logic
  enterTenantContext({ tenantId });
  next();
});
```

### 3. Bind Context for Background Jobs

```typescript
import { TenantContext } from '@happyvertical/smrt-tenancy';

// Preserve context across async boundaries
setTimeout(TenantContext.bind(() => {
  console.log(getTenantId()); // Still has context!
}), 1000);
```

### 4. Test with Real Tenant Context

```typescript
// Don't mock tenant context - use real withTenant()
it('should handle tenant data', async () => {
  await withTenant({ tenantId: 'test-tenant' }, async () => {
    // Real tenant isolation in tests
  });
});
```

## Related Documentation

- **AUTO_POPULATE_GUIDE.md**: Detailed guide for auto-population feature
- [Issue #688: tenantScoped decorator](https://github.com/happyvertical/smrt/issues/688)
- [Issue #809: Auto-populate tenantId](https://github.com/happyvertical/smrt/issues/809)
- [RFC-001: Multi-Tenancy](../../docs/rfcs/RFC-001-multi-tenancy.md)

## API Reference

### Context Functions

- `getCurrentTenant()`: Get current context (may be undefined)
- `requireTenant()`: Get context or throw error
- `getTenantId()`: Get tenant ID (may be undefined)
- `requireTenantId()`: Get tenant ID or throw error
- `hasTenantContext()`: Check if context exists
- `withTenant(context, fn)`: Run function in tenant context
- `withSystemContext(fn)`: Run function without tenant context
- `withSuperAdminBypass(fn)`: Run with bypass enabled
- `enterTenantContext(context)`: Establish persistent context

### Interceptor Functions

- `enableTenancy(options)`: Enable global tenant enforcement
- `disableTenancy()`: Disable tenant enforcement
- `isTenancyEnabled()`: Check if enabled
- `createTenantInterceptor(options)`: Create interceptor instance

### Registry Functions

- `isTenantScopedClass(className)`: Check if class is tenant-scoped
- `getTenantScopedConfig(className)`: Get tenant config for class
- `registerTenantScopedClass(className, config)`: Manual registration

### Errors

- `TenantContextError`: Missing required tenant context
- `TenantIsolationError`: Tenant isolation violation

## Package Structure

```
@happyvertical/smrt-tenancy/
├── src/
│   ├── context.ts          # AsyncLocalStorage-based context
│   ├── interceptor.ts      # beforeSave/beforeList/beforeGet hooks
│   ├── registry.ts         # Tenant-scoped class registry
│   ├── decorators.ts       # @TenantScoped decorator
│   ├── fields.ts           # tenantId field helper
│   ├── adapters/           # Middleware adapters
│   │   ├── express.ts
│   │   ├── sveltekit.ts
│   │   └── cli.ts
│   └── __tests__/
├── CLAUDE.md               # This file
├── AUTO_POPULATE_GUIDE.md  # Auto-population guide
└── README.md               # Package README
```
