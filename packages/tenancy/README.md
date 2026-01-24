# @happyvertical/smrt-tenancy

**Multi-tenant data isolation for SMRT applications with automatic filtering and population.**

## Features

- ✅ **Auto-filtering**: Queries automatically scoped by tenant
- ✅ **Auto-population**: `tenantId` automatically injected on create/save
- ✅ **AsyncLocalStorage**: Context propagates through async operations
- ✅ **Middleware Support**: Express, SvelteKit, and custom adapters
- ✅ **Testing Helpers**: Easy tenant context setup for tests

## Installation

```bash
npm install @happyvertical/smrt-tenancy
```

## Quick Start

### 1. Define Tenant-Scoped Classes

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ tenantScoped: true })
class Document extends SmrtObject {
  title: string = '';
  content: string = '';
  // tenantId field auto-injected
}
```

### 2. Enable Tenancy

```typescript
import { enableTenancy } from '@happyvertical/smrt-tenancy';

// At application startup
enableTenancy();
```

### 3. Use Tenant Context

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-123' }, async () => {
  // Auto-population - no manual tenantId!
  const doc = await collection.create({
    title: 'My Document',
    content: 'Hello World',
    // tenantId = 'tenant-123' automatically
  });

  // Auto-filtering - only sees tenant-123's data
  const docs = await collection.list({});
});
```

## Auto-Population (Issue #809)

The `tenantId` field is automatically populated from the current tenant context:

```typescript
await withTenant({ tenantId: 'acme-corp' }, async () => {
  // ✅ BEFORE (manual)
  const build = await collection.create({
    contractId: '123',
    tenantId: 'acme-corp',  // Manual
  });

  // ✅ AFTER (automatic)
  const build = await collection.create({
    contractId: '123',
    // tenantId auto-populated!
  });
});
```

**Requirements**:
1. Call `enableTenancy()` at startup
2. Wrap operations in `withTenant({ tenantId })` context
3. Use `@smrt({ tenantScoped: true })` decorator

See [AUTO_POPULATE_GUIDE.md](./AUTO_POPULATE_GUIDE.md) for complete documentation.

## Configuration Options

```typescript
@smrt({
  tenantScoped: {
    mode: 'required',              // 'required' | 'optional'
    field: 'tenantId',             // Custom field name
    autoFilter: true,              // Auto-filter queries
    autoPopulate: true,            // Auto-populate on save
    allowSuperAdminBypass: false,  // Allow cross-tenant ops
  }
})
class MyClass extends SmrtObject {}
```

## Middleware Integration

### Express

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

### SvelteKit

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

## Testing

```typescript
import { withTenant, enableTenancy } from '@happyvertical/smrt-tenancy';

describe('Document', () => {
  beforeEach(() => {
    enableTenancy();
  });

  it('should auto-populate tenantId', async () => {
    await withTenant({ tenantId: 'test' }, async () => {
      const doc = await collection.create({ title: 'Test' });
      expect(doc.tenantId).toBe('test');
    });
  });
});
```

## Common Mistakes

### ❌ Forgetting to Call `enableTenancy()`

```typescript
// Missing enableTenancy() - auto-population won't work!
await withTenant({ tenantId: 'test' }, async () => {
  const doc = await collection.create({ title: 'Test' });
  // tenantId NOT populated
});
```

### ❌ Not Using `withTenant()` Context

```typescript
enableTenancy();

// Missing withTenant() wrapper!
const doc = await collection.create({
  title: 'Test',
  tenantId: 'manual',  // Still manual!
});
```

### ❌ Providing Conflicting `tenantId`

```typescript
await withTenant({ tenantId: 'tenant-123' }, async () => {
  const doc = await collection.create({
    title: 'Test',
    tenantId: 'different',  // ⚠️ Throws TenantIsolationError!
  });
});
```

## Advanced Features

### Super Admin Bypass

```typescript
import { withSuperAdminBypass } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'admin' }, async () => {
  await withSuperAdminBypass(async () => {
    // Can see ALL tenants' data
    const allDocs = await collection.list({});
  });
});
```

### System Context (No Tenant)

```typescript
import { withSystemContext } from '@happyvertical/smrt-tenancy';

await withSystemContext(async () => {
  // No tenant checks - for migrations, background jobs
  const allData = await collection.list({});
});
```

### Custom Tenant Field

```typescript
@smrt({
  tenantScoped: {
    field: 'organizationId',  // Use custom field
  }
})
class User extends SmrtObject {
  name: string = '';
  // organizationId auto-injected
}
```

## API Reference

### Context

- `withTenant(context, fn)` - Run function in tenant context
- `getCurrentTenant()` - Get current context (may be undefined)
- `requireTenant()` - Get context or throw error
- `getTenantId()` - Get tenant ID (may be undefined)
- `requireTenantId()` - Get tenant ID or throw error
- `hasTenantContext()` - Check if context exists
- `withSystemContext(fn)` - Run without tenant context
- `withSuperAdminBypass(fn)` - Run with bypass enabled
- `enterTenantContext(context)` - Establish persistent context

### Interceptor

- `enableTenancy(options)` - Enable global enforcement
- `disableTenancy()` - Disable enforcement
- `isTenancyEnabled()` - Check if enabled

### Errors

- `TenantContextError` - Missing required context
- `TenantIsolationError` - Isolation violation

## Documentation

- [CLAUDE.md](./CLAUDE.md) - Complete technical documentation
- [AUTO_POPULATE_GUIDE.md](./AUTO_POPULATE_GUIDE.md) - Auto-population guide
- [Issue #688](https://github.com/happyvertical/smrt/issues/688) - tenantScoped decorator
- [Issue #809](https://github.com/happyvertical/smrt/issues/809) - Auto-populate feature

## License

MIT
