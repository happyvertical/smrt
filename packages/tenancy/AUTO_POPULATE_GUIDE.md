# Auto-Populating tenantId with @smrt({ tenantScoped: true })

**Status**: ✅ Feature already implemented (Issue #688, #809)

The `@smrt({ tenantScoped: true })` decorator automatically populates `tenantId` from the current tenant context when you save objects.

## Quick Start

### 1. Define Your SMRT Class

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ tenantScoped: true })
class Build extends SmrtObject {
  contractId: string = '';
  status: string = '';
  // tenantId field is auto-injected by the decorator
}
```

### 2. Enable Tenancy at Application Startup

```typescript
import { enableTenancy } from '@happyvertical/smrt-tenancy';

// Call once at app startup
enableTenancy();
```

### 3. Use Within Tenant Context

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

const tenantId = 'tenant-123';

await withTenant({ tenantId }, async () => {
  // Create without manually providing tenantId
  const build = await buildCollection.create({
    contractId: 'contract-abc',
    status: 'pending',
    // NO tenantId needed! Auto-populated from context
  });

  console.log(build.tenantId); // 'tenant-123'
});
```

## How It Works

1. **Decorator**: `@smrt({ tenantScoped: true })` registers the class with tenancy config
2. **Interceptor**: `enableTenancy()` registers a global interceptor
3. **Context**: `withTenant()` establishes AsyncLocalStorage-based context
4. **Auto-populate**: `beforeSave` interceptor injects `tenantId` from context

## Configuration Options

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
```

## Common Issues

### Issue: tenantId Not Auto-Populated

**Symptom**: You have to manually provide `tenantId` in factories

**Causes**:
1. ❌ `enableTenancy()` not called at app startup
2. ❌ Code not running within `withTenant()` context
3. ❌ `@happyvertical/smrt-tenancy` package not installed

**Solution**:
```typescript
// ✅ CORRECT
import { enableTenancy, withTenant } from '@happyvertical/smrt-tenancy';

enableTenancy(); // At startup

await withTenant({ tenantId: TEST_TENANT_ID }, async () => {
  const build = await buildCollection.create({
    contractId: 'abc',
    // tenantId auto-populated!
  });
});

// ❌ WRONG - No tenant context
const build = await buildCollection.create({
  contractId: 'abc',
  tenantId: TEST_TENANT_ID, // Manual - not needed!
});
```

### Issue: Tenant Isolation Violation

**Symptom**: Error when explicitly providing different `tenantId`

**Cause**: You're trying to create a record for a different tenant

**Solution**: Don't override `tenantId` - let it auto-populate

```typescript
await withTenant({ tenantId: 'tenant-123' }, async () => {
  // ❌ WRONG - Throws TenantIsolationError
  const build = await buildCollection.create({
    tenantId: 'different-tenant', // Mismatch!
  });

  // ✅ CORRECT - Auto-populated
  const build = await buildCollection.create({
    contractId: 'abc',
    // tenantId is 'tenant-123'
  });
});
```

## Testing

For tests, use `withTenant()` to establish context:

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

describe('Build', () => {
  it('should auto-populate tenantId', async () => {
    await withTenant({ tenantId: 'test-tenant' }, async () => {
      const build = await buildCollection.create({
        contractId: 'abc',
      });

      expect(build.tenantId).toBe('test-tenant');
    });
  });
});
```

## Middleware Integration

### Express

```typescript
import { enterTenantContext } from '@happyvertical/smrt-tenancy';

app.use((req, res, next) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  if (tenantId) {
    enterTenantContext({ tenantId });
  }
  next();
});
```

### SvelteKit

```typescript
import { enterTenantContext } from '@happyvertical/smrt-tenancy';

export const handle = async ({ event, resolve }) => {
  const tenantId = event.cookies.get('tenantId');
  if (tenantId) {
    enterTenantContext({ tenantId });
  }
  return resolve(event);
};
```

## Related Documentation

- [Issue #688: tenantScoped decorator](https://github.com/happyvertical/smrt/issues/688)
- [Issue #809: Auto-populate tenantId](https://github.com/happyvertical/smrt/issues/809)
- [RFC-001: Multi-Tenancy](../docs/rfcs/RFC-001-multi-tenancy.md)
- [Tenancy Package README](./README.md)

## FAQ

**Q: Do I need to install `@happyvertical/smrt-tenancy`?**
A: Yes! The auto-population happens in the tenancy package interceptor.

**Q: Can I use `@smrt({ tenantScoped: true })` without the tenancy package?**
A: Yes, but you won't get auto-population or auto-filtering. You'll have to manually manage `tenantId`.

**Q: How do I disable auto-population?**
A: Set `autoPopulate: false` in the decorator config:
```typescript
@smrt({
  tenantScoped: {
    autoPopulate: false  // Manual tenantId required
  }
})
```

**Q: Can I use a different field name?**
A: Yes, use the `field` option:
```typescript
@smrt({
  tenantScoped: {
    field: 'organizationId'  // Use organizationId instead of tenantId
  }
})
```
