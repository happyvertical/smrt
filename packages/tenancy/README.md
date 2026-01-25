# @happyvertical/smrt-tenancy

Production-ready multi-tenancy framework for SMRT with automatic tenant isolation.

## Installation

```bash
npm install @happyvertical/smrt-tenancy
```

## Quick Start

```typescript
import { enableTenancy, TenantScoped, tenantId, withTenant } from '@happyvertical/smrt-tenancy';
import { smrt, SmrtObject } from '@happyvertical/smrt-core';

// 1. Enable tenancy globally (once at app startup)
enableTenancy();

// 2. Mark classes as tenant-scoped with @tenantId decorator
@smrt()
@TenantScoped({ mode: 'optional' })
class Document extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId?: string;  // null = global document

  title: string = '';
}

// 3. Wrap requests in tenant context
await withTenant({ tenantId: 'tenant-123' }, async () => {
  // Queries filtered to this tenant
  const docs = await documentCollection.list({ where: { status: 'active' } });
  // Executes: WHERE tenant_id = 'tenant-123' AND status = 'active'

  // To include globals, use findWithGlobals()
  const withGlobals = await documentCollection.findWithGlobals('tenant-123');
  // Executes: WHERE (tenant_id = 'tenant-123' OR tenant_id IS NULL)
});
```

## Tenancy Pattern

SMRT uses **optional tenancy** with a simple convention:

| tenantId Value | Meaning |
|----------------|---------|
| `null` | Global/network-wide resource (visible to all tenants) |
| `'tenant-123'` | Tenant-specific resource (only visible to that tenant) |

This enables both shared resources and tenant isolation in the same table.

### Use Cases

```typescript
// Global tag (shared vocabulary)
const globalTag = await tags.create({
  tenantId: null,  // Visible to all tenants
  slug: 'politics',
  name: 'Politics'
});

// Tenant-specific tag
const localTag = await tags.create({
  tenantId: 'bentley-news',
  slug: 'town-council-2024',
  name: 'Town Council 2024'
});

// Query gets both global AND tenant-specific
const allTags = await tags.findWithGlobals('bentley-news');
// Returns: [globalTag, localTag]
```

## Decorator Options

### @TenantScoped()

```typescript
@smrt()
@TenantScoped({
  mode: 'optional',           // 'required' | 'optional' (default: 'required')
  field: 'tenantId',          // Field name (default: 'tenantId')
  autoFilter: true,           // Auto-filter queries (default: true)
  autoPopulate: true,         // Auto-set tenantId from context (default: true)
  allowSuperAdminBypass: false // Allow cross-tenant access (default: false)
})
class Document extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId?: string;
}
```

### Mode Options

| Mode | Behavior |
|------|----------|
| `'required'` | Must have tenant context for all operations |
| `'optional'` | Works with or without tenant context; `null` means global |

**Recommendation**: Use `mode: 'optional'` for most models. This provides flexibility for both global resources and tenant-specific data.

## Property Decorator

### @tenantId()

The `@tenantId` decorator marks a property as the tenant identifier field. Use this decorator instead of the deprecated field helper to avoid field descriptor objects being accidentally saved to the database (see [issue #829](https://github.com/happyvertical/smrt/issues/829)).

```typescript
// Required tenant ID (no global resources allowed)
@tenantId()
tenantId?: string;

// Optional tenant ID (null = global)
@tenantId({ nullable: true })
tenantId?: string;

// With custom options
@tenantId({
  nullable: true,      // Allow null for global resources
  required: false,     // Don't require on save
  autoFilter: true,    // Auto-filter queries
  autoPopulate: true   // Auto-set from context
})
tenantId?: string;
```

## Context Management

### withTenant()

Run code within a tenant context:

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-123' }, async () => {
  // All operations scoped to this tenant
  const docs = await collection.list({});
});
```

### withSystemContext()

Run code without tenant filtering (admin/migration scripts):

```typescript
import { withSystemContext } from '@happyvertical/smrt-tenancy';

await withSystemContext(async () => {
  // No tenant filtering - sees ALL data
  const allDocs = await collection.list({});
});
```

### withSuperAdminBypass()

Cross-tenant operations while maintaining a "home" tenant:

```typescript
import { withSuperAdminBypass } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'admin-tenant' }, async () => {
  await withSuperAdminBypass(async () => {
    // Can access other tenants' data
    const otherDocs = await collection.list({
      where: { tenantId: 'other-tenant' }
    });
  });
});
```

### Context Utilities

```typescript
import {
  getCurrentTenant,
  getTenantId,
  requireTenantId,
  hasTenantContext,
  isSuperAdminBypass
} from '@happyvertical/smrt-tenancy';

// Get current tenant (may be undefined)
const ctx = getCurrentTenant();

// Get tenant ID (may be undefined)
const id = getTenantId();

// Get tenant ID or throw
const id = requireTenantId();

// Check if in tenant context
if (hasTenantContext()) { ... }

// Check if super admin bypass is active
if (isSuperAdminBypass()) { ... }
```

## Collection Methods

When implementing tenant-scoped collections, add these standard methods:

```typescript
class DocumentCollection extends SmrtCollection<Document> {
  /**
   * Find documents for a specific tenant only
   */
  async findByTenant(tenantId: string): Promise<Document[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find global documents (tenantId is null)
   */
  async findGlobal(): Promise<Document[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find tenant's documents + global documents
   * This is the typical query pattern for tenant views
   */
  async findWithGlobals(tenantId: string): Promise<Document[]> {
    return this.query(
      `
      SELECT * FROM documents
      WHERE tenant_id = ? OR tenant_id IS NULL
      ORDER BY created_at DESC
      `,
      [tenantId],
      { allowRawOnTenantScoped: true },
    );
  }
}
```

## Framework Adapters

### SvelteKit

```typescript
// hooks.server.ts
import { createSvelteKitHandle } from '@happyvertical/smrt-tenancy';

export const handle = createSvelteKitHandle({
  resolveTenantId: (event) => {
    // Extract tenant from subdomain, header, or path
    return event.url.hostname.split('.')[0];
  }
});
```

### Express

```typescript
import { createExpressMiddleware } from '@happyvertical/smrt-tenancy';

app.use(createExpressMiddleware({
  resolveTenantId: (req) => req.headers['x-tenant-id'] as string
}));
```

### CLI

```typescript
import { createCliContext } from '@happyvertical/smrt-tenancy';

// Create CLI context runner
const cli = createCliContext({
  resolveTenantId: () => process.env.TENANT_ID || 'default'
});

// Run code in tenant context
await cli.run(async () => {
  // Your CLI command code here
});
```

## Query Patterns

### Tenant's View (Most Common)

Get tenant's data plus global resources:

```typescript
// Using collection method
const items = await collection.findWithGlobals(tenantId);

// Using raw query
const items = await collection.query(`
  SELECT * FROM items
  WHERE tenant_id = ? OR tenant_id IS NULL
`, [tenantId]);
```

### Tenant Only

Exclude global resources:

```typescript
const items = await collection.findByTenant(tenantId);
```

### Global Only

Only global resources:

```typescript
const items = await collection.findGlobal();
```

### Cross-Tenant (Admin)

```typescript
await withSystemContext(async () => {
  // All tenants' data
  const all = await collection.list({});

  // Specific tenant
  const tenant1 = await collection.list({
    where: { tenantId: 'tenant-1' }
  });
});
```

## Model Patterns by Type

### Core Business Data

Tenant-specific with optional globals:

```typescript
// Content, Events, Contracts, etc.
@smrt()
@TenantScoped({ mode: 'optional' })
class Content extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId?: string;

  // ... fields
}
```

### Reference Data

Network-wide, no tenancy:

```typescript
// AssetType, PlaceType, AdFormat, etc.
@smrt()
class AssetType extends SmrtObject {
  // No tenantId - shared across network
  name: string = '';
}
```

### Shared Entities

Optional tenancy for B2B scenarios:

```typescript
// Customer, Vendor (might be known across tenants)
@smrt()
@TenantScoped({ mode: 'optional' })
class Customer extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId?: string;
  // null = known network-wide
  // set = tenant-specific relationship
}
```

### Audit/Admin Data

Optional with super admin bypass:

```typescript
@smrt()
@TenantScoped({ mode: 'optional', allowSuperAdminBypass: true })
class AuditLog extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId?: string;

  action: string = '';
}
```

## Testing

```typescript
import {
  setupTestTenancy,
  resetTenancy,
  createTestTenantContext,
  testTenantIsolation
} from '@happyvertical/smrt-tenancy';

describe('Document tenancy', () => {
  beforeEach(() => {
    setupTestTenancy();
  });

  afterEach(() => {
    resetTenancy();
  });

  it('isolates data by tenant', async () => {
    await testTenantIsolation(['tenant-a', 'tenant-b'], async (tenants) => {
      // Create in tenant A
      const docA = await tenants['tenant-a'](async () => {
        const doc = await collection.create({ title: 'Doc for tenant-a' });
        await doc.save();
        return doc;
      });

      // Verify not visible in tenant B
      await tenants['tenant-b'](async () => {
        const found = await collection.get({ id: docA.id });
        expect(found).toBeNull();
      });
    });
  });

  it('includes global resources', async () => {
    // Create global resource
    const global = await collection.create({
      tenantId: null,
      title: 'Global Doc'
    });
    await global.save();

    // Tenant sees global + their own
    await createTestTenantContext({ tenantId: 'tenant-1' }, async () => {
      const docs = await collection.findWithGlobals('tenant-1');
      expect(docs.some(d => d.id === global.id)).toBe(true);
    });
  });
});
```

## Migration Guide

### Adding Tenancy to Existing Models

1. Add the `@tenantId` decorator:

```typescript
@smrt()
@TenantScoped({ mode: 'optional' })
class ExistingModel extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId?: string;  // Add this

  // ... existing fields
}
```

2. Run database migration:

```sql
-- Add tenant_id column (nullable for existing data)
ALTER TABLE existing_models ADD COLUMN tenant_id TEXT;

-- Create index for performance
CREATE INDEX idx_existing_models_tenant ON existing_models(tenant_id);
```

3. Optionally assign existing records:

```sql
-- Assign to default tenant
UPDATE existing_models SET tenant_id = 'default-tenant'
WHERE tenant_id IS NULL;

-- Or leave as global (null = network-wide)
```

## Related

- [Issue #826](https://github.com/happyvertical/smrt/issues/826) - Tenancy epic tracking all modules
- [Issue #813](https://github.com/happyvertical/smrt/issues/813) - Original smrt-ads tenancy issue

## API Reference

### Exports

```typescript
// Decorators
export {
  TenantScoped,           // Class decorator
  type TenantScopedOptions,
  tenantId,               // Property decorator (preferred)
} from './decorators.js';

// Field helper (deprecated - use @tenantId decorator instead)
export {
  tenantIdFieldHelper,    // Renamed for backwards compat
  type TenantIdFieldOptions,
} from './fields.js';

// Context management
export {
  withTenant,
  withTenantSync,
  withSystemContext,
  withSuperAdminBypass,
  enterTenantContext,
  getCurrentTenant,
  getTenantId,
  requireTenant,
  requireTenantId,
  hasTenantContext,
  isSuperAdminBypass,
  TenantContext,
  TenantContextError,
  TenantIsolationError
} from './context.js';

// Framework adapters
export {
  createSvelteKitHandle,
  createExpressMiddleware,
  createCliContext
} from './adapters/index.js';

// Interceptor
export {
  enableTenancy,
  disableTenancy,
  isTenancyEnabled,
  createTenantInterceptor
} from './interceptor.js';

// Testing utilities
export {
  setupTestTenancy,
  resetTenancy,
  createTestTenantContext,
  testTenantIsolation,
  assertTenantContextRequired,
  assertTenantIsolationViolation
} from './testing.js';
```

## License

MIT
