# RFC-001: Production-Ready Multi-Tenancy for SMRT

**Status**: Draft
**Author**: Will
**Created**: 2026-01-10
**Target Version**: 0.19.0

## Summary

This RFC proposes adding framework-level multi-tenancy enforcement to SMRT through a new `@happyvertical/smrt-tenancy` package that integrates with `@happyvertical/smrt-users` and provides automatic tenant isolation at the database query and persistence layers.

## Motivation

### Current State

The SMRT framework has tenant **models** via `@happyvertical/smrt-users` (Tenant, User, Membership, Role, Permission) but **zero enforcement**. All tenant isolation must be manually implemented:

```typescript
// Current: Every query must manually include tenant filtering
const documents = await documentCollection.list({
  where: {
    tenantId: currentTenant.id,  // Easy to forget!
    status: 'active'
  }
});
```

This creates:
- **Security risk**: Missing tenant filter = cross-tenant data leakage
- **Developer burden**: Every query, every route, every service must handle tenancy
- **Inconsistency**: Each project implements tenancy differently
- **Maintenance overhead**: Can't evolve tenancy patterns centrally

### Goal

Make tenant isolation **impossible to bypass by accident**:

```typescript
// Proposed: Tenant filtering automatic and enforced
@smrt()
@TenantScoped()
class Document extends SmrtObject {
  tenantId = tenantId();  // Framework enforces this
  title: string = '';
}

// Queries automatically scoped - impossible to leak data
const documents = await documentCollection.list({
  where: { status: 'active' }  // tenantId auto-injected
});
```

## Design Decisions

Based on requirements discussion:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default DB Strategy | `shared-schema` | Most common pattern, simpler ops |
| Database-per-tenant | Supported | Needed for some use cases (blindmanpress) |
| Backwards Compatibility | Not required | Pre-release, time for major refactor |
| smrt-users Integration | Required | Single source of truth for tenants |
| Super Admin Bypass | Yes, explicit disable | Needed for admin UIs, must be opt-in |

## Critical Design Corrections

Based on architectural review, the following corrections are required before implementation:

### 1. Circular Dependency Prevention

**Problem:** The original design had `smrt-core` importing from `smrt-tenancy`, creating a circular dependency (`smrt-tenancy` → `smrt-core` → `smrt-tenancy`).

**Solution:** Invert the dependency using a generic interceptor registry in `smrt-core`:

```typescript
// In @happyvertical/smrt-core - no knowledge of tenancy
export interface CollectionInterceptor {
  beforeList?(className: string, options: ListOptions): ListOptions;
  afterGet?(className: string, instance: SmrtObject | null): SmrtObject | null;
  beforeSave?(instance: SmrtObject): void;
  beforeDelete?(instance: SmrtObject): void;
  beforeQuery?(className: string, sql: string, params: unknown[]): { sql: string; params: unknown[] };
}

export const GlobalInterceptors = {
  interceptors: [] as CollectionInterceptor[],

  register(interceptor: CollectionInterceptor): void {
    this.interceptors.push(interceptor);
  },

  unregister(interceptor: CollectionInterceptor): void {
    const idx = this.interceptors.indexOf(interceptor);
    if (idx >= 0) this.interceptors.splice(idx, 1);
  }
};

// In @happyvertical/smrt-tenancy - registers itself at runtime
import { GlobalInterceptors } from '@happyvertical/smrt-core';

export function enableTenancy(): void {
  GlobalInterceptors.register(createTenantInterceptor());
}
```

### 2. Raw SQL Bypass Policy

**Problem:** `SmrtCollection.query()` allows raw SQL that bypasses interceptors.

**Solution:** Three-tier policy:

```typescript
// Option 1: Throw error for tenant-scoped classes (default - secure)
await documents.query('SELECT * FROM documents');
// Throws: "Raw SQL queries not allowed on @TenantScoped classes. Use list() or withRawQuery()"

// Option 2: Explicit bypass with audit logging
await documents.withRawQuery(async (db) => {
  // Developer takes responsibility
  return db.query('SELECT * FROM documents WHERE tenant_id = ?', [tenantId]);
});

// Option 3: System context for migrations/admin tools
await withSystemContext(async () => {
  // Bypasses all tenant checks - requires explicit import
  await documents.query('SELECT * FROM documents');
});
```

### 3. Composite Unique Constraints

**Problem:** Unique constraints must be tenant-scoped.

**Solution:** Schema generation automatically creates composite indices:

```typescript
@smrt()
@TenantScoped()
class Document extends SmrtObject {
  tenantId = tenantId();
  slug: string = '';  // UNIQUE constraint becomes UNIQUE(tenant_id, slug)
}

// Generated SQL:
// CREATE UNIQUE INDEX idx_documents_tenant_slug ON documents(tenant_id, slug);
// NOT: CREATE UNIQUE INDEX idx_documents_slug ON documents(slug);
```

### 4. Context Binding for Background Jobs

**Problem:** AsyncLocalStorage context lost in `setTimeout`, event emitters, etc.

**Solution:** Explicit binding utilities:

```typescript
import { TenantContext } from '@happyvertical/smrt-tenancy';

// Bind callback to current context
setTimeout(TenantContext.bind(() => {
  // tenantId available here
  console.log(requireTenantId());
}), 1000);

// Bind event handler
emitter.on('event', TenantContext.bind(handler));

// For agents processing jobs from queue
const job = await queue.pop();
await TenantContext.runWithJobContext(job, async () => {
  // Context derived from job metadata
  await processJob(job);
});
```

---

## Detailed Design

### Package Structure

```
packages/tenancy/
├── src/
│   ├── index.ts                    # Public exports
│   ├── context.ts                  # TenantContext (AsyncLocalStorage)
│   ├── fields.ts                   # tenantId() field helper
│   ├── decorators.ts               # @TenantScoped decorator
│   ├── interceptor.ts              # Query/save interceptors
│   ├── errors.ts                   # Tenancy-specific errors
│   ├── database/
│   │   ├── routing.ts              # Database strategy routing
│   │   ├── shared-schema.ts        # Row-level filtering
│   │   └── database-per-tenant.ts  # Separate DB connections
│   ├── adapters/
│   │   ├── sveltekit.ts            # SvelteKit Handle
│   │   ├── express.ts              # Express middleware
│   │   └── cli.ts                  # CLI context helpers
│   └── admin/
│       └── bypass.ts               # Super admin bypass control
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

### Core Components

#### 1. TenantContext (AsyncLocalStorage)

Thread-local storage for tenant context that flows through async operations:

```typescript
// packages/tenancy/src/context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tenant, User } from '@happyvertical/smrt-users';

export interface TenantContextData {
  /** Current tenant ID (required) */
  tenantId: string;
  /** Current tenant object (lazy-loaded) */
  tenant?: Tenant;
  /** Current user ID (optional) */
  userId?: string;
  /** Current user object (lazy-loaded) */
  user?: User;
  /** Resolved permissions for this user in this tenant */
  permissions: Set<string>;
  /** Database connection for this tenant (if database-per-tenant) */
  database?: DatabaseInterface;
  /** Super admin bypass enabled */
  superAdminBypass?: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

const tenantStorage = new AsyncLocalStorage<TenantContextData>();

/**
 * Get current tenant context (may be undefined)
 */
export function getCurrentTenant(): TenantContextData | undefined {
  return tenantStorage.getStore();
}

/**
 * Get current tenant context or throw
 */
export function requireTenant(): TenantContextData {
  const ctx = tenantStorage.getStore();
  if (!ctx) {
    throw new TenantContextError(
      'No tenant context available. ' +
      'Ensure request is wrapped in withTenant() or middleware is configured.'
    );
  }
  return ctx;
}

/**
 * Get current tenant ID or throw
 */
export function requireTenantId(): string {
  return requireTenant().tenantId;
}

/**
 * Check if we're in a tenant context
 */
export function hasTenantContext(): boolean {
  return tenantStorage.getStore() !== undefined;
}

/**
 * Run code within a tenant context
 */
export async function withTenant<T>(
  context: TenantContextData,
  fn: () => Promise<T>
): Promise<T> {
  return tenantStorage.run(context, fn);
}

/**
 * Run code within a tenant context (sync version)
 */
export function withTenantSync<T>(
  context: TenantContextData,
  fn: () => T
): T {
  return tenantStorage.run(context, fn);
}
```

#### 2. tenantId Field Helper

A specialized foreign key that signals tenancy requirements to the framework:

```typescript
// packages/tenancy/src/fields.ts
import { foreignKey, type FieldDefinition } from '@happyvertical/smrt-core/fields';
import { Tenant } from '@happyvertical/smrt-users';

export interface TenantIdFieldOptions {
  /**
   * Auto-filter queries by current tenant context
   * @default true
   */
  autoFilter?: boolean;

  /**
   * Require tenant context for queries/saves
   * @default true
   */
  required?: boolean;

  /**
   * Auto-populate from context on create
   * @default true
   */
  autoPopulate?: boolean;

  /**
   * Allow super admin to bypass tenant filtering
   * @default false - must be explicitly enabled
   */
  allowSuperAdminBypass?: boolean;
}

const DEFAULT_OPTIONS: TenantIdFieldOptions = {
  autoFilter: true,
  required: true,
  autoPopulate: true,
  allowSuperAdminBypass: false,  // Secure by default
};

/**
 * Define a tenant ID field with automatic filtering and validation
 *
 * @example
 * ```typescript
 * class Document extends SmrtObject {
 *   tenantId = tenantId();  // Full enforcement
 *   title: string = '';
 * }
 * ```
 */
export function tenantId(options: TenantIdFieldOptions = {}): FieldDefinition {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const field = foreignKey(Tenant);

  // Attach tenancy metadata for interceptor
  return {
    ...field,
    __tenancy: opts,
  };
}

/**
 * Check if a field definition is a tenantId field
 */
export function isTenantIdField(field: FieldDefinition): boolean {
  return '__tenancy' in field;
}

/**
 * Get tenancy options from a field definition
 */
export function getTenancyOptions(field: FieldDefinition): TenantIdFieldOptions | null {
  return (field as any).__tenancy ?? null;
}
```

#### 3. @TenantScoped Decorator

Class-level decorator for tenant-scoped objects:

```typescript
// packages/tenancy/src/decorators.ts
import { ObjectRegistry } from '@happyvertical/smrt-core';

export interface TenantScopedOptions {
  /**
   * Tenancy mode for this class
   * - 'required': Must have tenant context for all operations
   * - 'optional': Works with or without tenant context
   */
  mode?: 'required' | 'optional';

  /**
   * Field name containing tenant ID
   * @default 'tenantId'
   */
  field?: string;

  /**
   * Auto-filter all queries by tenant
   * @default true
   */
  autoFilter?: boolean;

  /**
   * Validate tenant on save operations
   * @default true
   */
  validateOnSave?: boolean;

  /**
   * Prevent updates to objects from different tenants
   * @default true
   */
  preventCrossTenantUpdate?: boolean;

  /**
   * Allow super admin bypass for this class
   * @default false
   */
  allowSuperAdminBypass?: boolean;
}

const DEFAULT_OPTIONS: TenantScopedOptions = {
  mode: 'required',
  field: 'tenantId',
  autoFilter: true,
  validateOnSave: true,
  preventCrossTenantUpdate: true,
  allowSuperAdminBypass: false,
};

/**
 * Mark a class as tenant-scoped
 *
 * @example
 * ```typescript
 * @smrt()
 * @TenantScoped()
 * class Document extends SmrtObject {
 *   tenantId = tenantId();
 *   title: string = '';
 * }
 * ```
 */
export function TenantScoped(options: TenantScopedOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return function <T extends { new (...args: any[]): any }>(constructor: T) {
    // Register tenancy config with ObjectRegistry
    const existingConfig = ObjectRegistry.getConfig(constructor.name) || {};

    ObjectRegistry.register(constructor.name, {
      ...existingConfig,
      tenancy: opts,
    });

    return constructor;
  };
}

/**
 * Get tenancy configuration for a class
 */
export function getTenancyConfig(className: string): TenantScopedOptions | null {
  const config = ObjectRegistry.getConfig(className);
  return config?.tenancy ?? null;
}

/**
 * Check if a class is tenant-scoped
 */
export function isTenantScoped(className: string): boolean {
  return getTenancyConfig(className) !== null;
}
```

#### 4. Query & Save Interceptors

Core enforcement at the collection and object level:

```typescript
// packages/tenancy/src/interceptor.ts
import {
  getCurrentTenant,
  requireTenant,
  type TenantContextData
} from './context.js';
import { getTenancyConfig, type TenantScopedOptions } from './decorators.js';
import {
  TenantContextError,
  CrossTenantAccessError,
  TenantValidationError
} from './errors.js';

export interface TenantInterceptor {
  /**
   * Called before list() operations
   * Injects tenant filter into where clause
   */
  beforeList(
    className: string,
    options: ListOptions
  ): ListOptions;

  /**
   * Called before get() operations
   * Validates tenant access after retrieval
   */
  afterGet(
    className: string,
    instance: SmrtObject | null
  ): SmrtObject | null;

  /**
   * Called before save() operations
   * Validates and populates tenant ID
   */
  beforeSave(instance: SmrtObject): void;

  /**
   * Called before delete() operations
   * Validates tenant access
   */
  beforeDelete(instance: SmrtObject): void;
}

export function createTenantInterceptor(): TenantInterceptor {
  return {
    beforeList(className: string, options: ListOptions): ListOptions {
      const config = getTenancyConfig(className);
      if (!config) return options;  // Not tenant-scoped

      const ctx = getCurrentTenant();
      const field = config.field || 'tenantId';

      // Check if super admin bypass is allowed and active
      if (config.allowSuperAdminBypass && ctx?.superAdminBypass) {
        return options;  // Skip filtering for super admin
      }

      // Required mode: must have context
      if (config.mode === 'required' && !ctx) {
        throw new TenantContextError(
          `Tenant context required to query ${className}. ` +
          `Wrap operation in withTenant() or configure middleware.`
        );
      }

      // Auto-filter if enabled and we have context
      if (config.autoFilter && ctx) {
        // Don't override if tenant filter already specified
        if (options.where?.[field] !== undefined) {
          // Validate it matches current tenant (prevent tampering)
          if (options.where[field] !== ctx.tenantId) {
            throw new CrossTenantAccessError(
              `Cannot query ${className} with different tenant ID`
            );
          }
          return options;
        }

        return {
          ...options,
          where: {
            ...options.where,
            [field]: ctx.tenantId,
          }
        };
      }

      return options;
    },

    afterGet(className: string, instance: SmrtObject | null): SmrtObject | null {
      if (!instance) return null;

      const config = getTenancyConfig(className);
      if (!config) return instance;

      const ctx = getCurrentTenant();
      const field = config.field || 'tenantId';
      const instanceTenantId = (instance as any)[field];

      // Check super admin bypass
      if (config.allowSuperAdminBypass && ctx?.superAdminBypass) {
        return instance;
      }

      // Validate tenant access
      if (ctx && instanceTenantId && instanceTenantId !== ctx.tenantId) {
        throw new CrossTenantAccessError(
          `Cannot access ${className} belonging to different tenant`
        );
      }

      return instance;
    },

    beforeSave(instance: SmrtObject): void {
      const className = instance.constructor.name;
      const config = getTenancyConfig(className);
      if (!config) return;

      const ctx = getCurrentTenant();
      const field = config.field || 'tenantId';
      let tenantValue = (instance as any)[field];

      // Check super admin bypass
      if (config.allowSuperAdminBypass && ctx?.superAdminBypass) {
        // Super admin can save to any tenant, but must specify
        if (config.validateOnSave && !tenantValue) {
          throw new TenantValidationError(
            `${field} is required for ${className} (super admin must specify tenant)`
          );
        }
        return;
      }

      // Auto-populate from context on create (no existing value)
      if (!tenantValue && ctx) {
        (instance as any)[field] = ctx.tenantId;
        tenantValue = ctx.tenantId;
      }

      // Validate required
      if (config.validateOnSave && config.mode === 'required' && !tenantValue) {
        throw new TenantValidationError(
          `${field} is required for ${className}. ` +
          `Ensure tenant context is available or set ${field} explicitly.`
        );
      }

      // Prevent cross-tenant updates
      if (config.preventCrossTenantUpdate && ctx && tenantValue) {
        if (tenantValue !== ctx.tenantId) {
          throw new CrossTenantAccessError(
            `Cannot save ${className} to different tenant. ` +
            `Instance tenant: ${tenantValue}, Context tenant: ${ctx.tenantId}`
          );
        }
      }
    },

    beforeDelete(instance: SmrtObject): void {
      const className = instance.constructor.name;
      const config = getTenancyConfig(className);
      if (!config) return;

      const ctx = getCurrentTenant();
      const field = config.field || 'tenantId';
      const tenantValue = (instance as any)[field];

      // Check super admin bypass
      if (config.allowSuperAdminBypass && ctx?.superAdminBypass) {
        return;
      }

      // Prevent cross-tenant deletes
      if (config.preventCrossTenantUpdate && ctx && tenantValue) {
        if (tenantValue !== ctx.tenantId) {
          throw new CrossTenantAccessError(
            `Cannot delete ${className} belonging to different tenant`
          );
        }
      }
    }
  };
}

// Global interceptor instance
let globalInterceptor: TenantInterceptor | null = null;

export function getTenantInterceptor(): TenantInterceptor {
  if (!globalInterceptor) {
    globalInterceptor = createTenantInterceptor();
  }
  return globalInterceptor;
}

export function setTenantInterceptor(interceptor: TenantInterceptor): void {
  globalInterceptor = interceptor;
}
```

#### 5. smrt-users Integration

Deep integration with the existing users package:

```typescript
// packages/tenancy/src/integration/users.ts
import {
  TenantCollection,
  UserCollection,
  MembershipCollection,
  PermissionResolver,
  type Tenant,
  type User,
  type Membership,
} from '@happyvertical/smrt-users';
import { withTenant, type TenantContextData } from '../context.js';

export interface TenantResolutionOptions {
  /** Database configuration */
  db: DatabaseConfig;
  /** User ID to resolve tenant for */
  userId: string;
  /** Specific tenant ID (if known) */
  tenantId?: string;
  /** Email for super admin check */
  email?: string;
  /** Super admin email list */
  superAdminEmails?: string[];
}

export interface ResolvedTenantContext extends TenantContextData {
  tenant: Tenant;
  user: User;
  membership: Membership;
  isSuperAdmin: boolean;
}

/**
 * Resolve full tenant context from user session
 * Integrates with smrt-users for tenant/membership lookup
 */
export async function resolveTenantContext(
  options: TenantResolutionOptions
): Promise<ResolvedTenantContext | null> {
  const { db, userId, tenantId, email, superAdminEmails = [] } = options;

  // Initialize collections
  const userCollection = await UserCollection.create({ db });
  const tenantCollection = await TenantCollection.create({ db });
  const membershipCollection = await MembershipCollection.create({ db });

  // Get user
  const user = await userCollection.get(userId);
  if (!user) return null;

  // Check super admin
  const isSuperAdmin = email
    ? superAdminEmails.map(e => e.toLowerCase()).includes(email.toLowerCase())
    : false;

  // Get memberships
  const memberships = await membershipCollection.findActiveByUser(userId);
  if (memberships.length === 0 && !isSuperAdmin) {
    return null;
  }

  // Resolve target tenant
  let tenant: Tenant | null = null;
  let membership: Membership | null = null;

  if (tenantId) {
    // Specific tenant requested
    tenant = await tenantCollection.get(tenantId);
    membership = memberships.find(m => m.tenantId === tenantId) || null;

    // Super admin can access any tenant
    if (!membership && !isSuperAdmin) {
      return null;  // No access to this tenant
    }
  } else {
    // Use first available membership
    membership = memberships[0] || null;
    if (membership?.tenantId) {
      tenant = await tenantCollection.get(membership.tenantId);
    }
  }

  if (!tenant) return null;

  // Resolve permissions
  const resolver = await PermissionResolver.create({ db });
  const permResult = await resolver.resolvePermissions(userId, tenant.id!);

  return {
    tenantId: tenant.id!,
    tenant,
    userId,
    user,
    membership: membership!,
    permissions: permResult.permissions,
    isSuperAdmin,
    superAdminBypass: isSuperAdmin,  // Enable by default for super admins
  };
}

/**
 * Run code with resolved tenant context from user session
 */
export async function withResolvedTenant<T>(
  options: TenantResolutionOptions,
  fn: (context: ResolvedTenantContext) => Promise<T>
): Promise<T | null> {
  const context = await resolveTenantContext(options);
  if (!context) return null;

  return withTenant(context, () => fn(context));
}
```

#### 6. Database Strategies

Support for multiple database isolation patterns:

```typescript
// packages/tenancy/src/database/routing.ts
import { getDatabase, type DatabaseInterface, type DatabaseConfig } from '@happyvertical/sql';
import { getCurrentTenant, requireTenantId } from '../context.js';

export type TenantDatabaseStrategy =
  | 'shared-schema'        // Default: All tenants same DB, row filtering
  | 'schema-per-tenant'    // Same DB, different PostgreSQL schema per tenant
  | 'database-per-tenant'; // Separate database per tenant

export interface TenantDatabaseConfig {
  /** Database isolation strategy */
  strategy: TenantDatabaseStrategy;

  /** Base database connection (for shared-schema and schema-per-tenant) */
  baseConnection?: DatabaseConfig;

  /** Resolve connection for tenant (database-per-tenant) */
  resolveConnection?: (tenantId: string) => Promise<DatabaseConfig>;

  /** Resolve schema name for tenant (schema-per-tenant) */
  resolveSchema?: (tenantId: string) => string;

  /** Connection pool settings per tenant */
  poolConfig?: {
    maxConnections?: number;
    idleTimeoutMs?: number;
    connectionTimeoutMs?: number;
  };
}

// Connection pool cache for database-per-tenant
const tenantPools = new Map<string, DatabaseInterface>();

/**
 * Get database connection for current tenant context
 */
export async function getTenantDatabase(
  config: TenantDatabaseConfig
): Promise<DatabaseInterface> {
  const tenantId = requireTenantId();
  return getTenantDatabaseById(config, tenantId);
}

/**
 * Get database connection for specific tenant
 */
export async function getTenantDatabaseById(
  config: TenantDatabaseConfig,
  tenantId: string
): Promise<DatabaseInterface> {
  switch (config.strategy) {
    case 'shared-schema':
      // Single database, row-level filtering handled by interceptor
      if (!config.baseConnection) {
        throw new Error('baseConnection required for shared-schema strategy');
      }
      return getDatabase(config.baseConnection);

    case 'schema-per-tenant': {
      if (!config.baseConnection) {
        throw new Error('baseConnection required for schema-per-tenant strategy');
      }
      const db = await getDatabase(config.baseConnection);
      const schema = config.resolveSchema?.(tenantId) ?? `tenant_${tenantId}`;

      // Set search path for this connection
      await db.execute({ sql: `SET search_path TO "${schema}", public` });
      return db;
    }

    case 'database-per-tenant': {
      // Check cache first
      if (tenantPools.has(tenantId)) {
        return tenantPools.get(tenantId)!;
      }

      if (!config.resolveConnection) {
        throw new Error('resolveConnection required for database-per-tenant strategy');
      }

      const dbConfig = await config.resolveConnection(tenantId);
      const db = await getDatabase(dbConfig);

      // Cache the connection
      tenantPools.set(tenantId, db);
      return db;
    }

    default:
      throw new Error(`Unknown database strategy: ${config.strategy}`);
  }
}

/**
 * Close all tenant database connections
 */
export async function closeTenantPools(): Promise<void> {
  for (const [tenantId, db] of tenantPools) {
    try {
      await db.close?.();
    } catch (e) {
      console.error(`Error closing pool for tenant ${tenantId}:`, e);
    }
  }
  tenantPools.clear();
}
```

#### 7. SvelteKit Adapter

First-class SvelteKit integration:

```typescript
// packages/tenancy/src/adapters/sveltekit.ts
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { withTenant, type TenantContextData } from '../context.js';
import { resolveTenantContext, type TenantResolutionOptions } from '../integration/users.js';

export interface SvelteKitTenancyOptions {
  /** Database configuration */
  db: DatabaseConfig;

  /** Extract user session from request */
  getSession: (event: RequestEvent) => Promise<{
    userId: string;
    email?: string;
    tenantId?: string;
  } | null>;

  /** Super admin email addresses */
  superAdminEmails?: string[];

  /** Routes that don't require tenant context */
  publicRoutes?: string[];

  /** Routes that bypass tenant for super admin */
  adminRoutes?: string[];

  /** Called when tenant resolution fails */
  onNoTenant?: (event: RequestEvent) => Response | void;
}

/**
 * Create SvelteKit handle for tenant context
 */
export function createTenancyHandle(options: SvelteKitTenancyOptions): Handle {
  const {
    db,
    getSession,
    superAdminEmails = [],
    publicRoutes = [],
    adminRoutes = [],
    onNoTenant,
  } = options;

  return async ({ event, resolve }) => {
    const { pathname } = event.url;

    // Skip public routes
    if (publicRoutes.some(route => pathname.startsWith(route))) {
      return resolve(event);
    }

    // Get session
    const session = await getSession(event);
    if (!session) {
      // No session - continue without tenant context
      // (route handlers can check for auth)
      return resolve(event);
    }

    // Resolve tenant context
    const context = await resolveTenantContext({
      db,
      userId: session.userId,
      tenantId: session.tenantId,
      email: session.email,
      superAdminEmails,
    });

    if (!context) {
      // No tenant access
      if (onNoTenant) {
        const response = onNoTenant(event);
        if (response) return response;
      }
      return resolve(event);
    }

    // Check if this is an admin route (super admin bypass allowed)
    const isAdminRoute = adminRoutes.some(route => pathname.startsWith(route));
    if (isAdminRoute && context.isSuperAdmin) {
      context.superAdminBypass = true;
    } else {
      // Explicitly disable super admin bypass for non-admin routes
      context.superAdminBypass = false;
    }

    // Store in locals for page/endpoint access
    event.locals.tenantContext = context;
    event.locals.tenantId = context.tenantId;
    event.locals.tenant = context.tenant;
    event.locals.permissions = context.permissions;
    event.locals.isSuperAdmin = context.isSuperAdmin;

    // Run request within tenant context
    return withTenant(context, () => resolve(event));
  };
}

// Type augmentation for SvelteKit
declare global {
  namespace App {
    interface Locals {
      tenantContext?: TenantContextData;
      tenantId?: string;
      tenant?: Tenant;
      permissions?: Set<string>;
      isSuperAdmin?: boolean;
    }
  }
}
```

#### 8. Super Admin Bypass Control

Explicit control over super admin capabilities:

```typescript
// packages/tenancy/src/admin/bypass.ts
import { getCurrentTenant, withTenant, type TenantContextData } from '../context.js';

/**
 * Explicitly enable super admin bypass for a code block
 * Use with extreme caution - only for admin UIs
 *
 * @example
 * ```typescript
 * // In admin dashboard route
 * const allTenants = await withSuperAdminBypass(async () => {
 *   // Can query across all tenants
 *   return tenantCollection.list();
 * });
 * ```
 */
export async function withSuperAdminBypass<T>(
  fn: () => Promise<T>
): Promise<T> {
  const ctx = getCurrentTenant();
  if (!ctx) {
    throw new Error('Cannot enable super admin bypass without tenant context');
  }

  if (!ctx.isSuperAdmin) {
    throw new Error('Super admin bypass requires isSuperAdmin flag');
  }

  // Run with bypass enabled
  return withTenant(
    { ...ctx, superAdminBypass: true },
    fn
  );
}

/**
 * Explicitly disable super admin bypass
 * Use to ensure tenant isolation even for super admins
 */
export async function withoutSuperAdminBypass<T>(
  fn: () => Promise<T>
): Promise<T> {
  const ctx = getCurrentTenant();
  if (!ctx) {
    return fn();  // No context, no bypass possible
  }

  return withTenant(
    { ...ctx, superAdminBypass: false },
    fn
  );
}

/**
 * Check if super admin bypass is currently active
 */
export function isSuperAdminBypassActive(): boolean {
  const ctx = getCurrentTenant();
  return ctx?.superAdminBypass === true;
}
```

### System Table Updates

Add tenant_id to all SMRT system tables:

```typescript
// packages/tenancy/src/migrations/001_add_tenant_columns.ts
import type { Migration } from '@happyvertical/smrt-core/migrations';

export default {
  id: '001_add_tenant_columns',
  description: 'Add tenant_id column to system tables for multi-tenant isolation',

  up: async (db) => {
    const tables = [
      '_smrt_contexts',
      '_smrt_embeddings',
      '_smrt_dispatch',
      '_smrt_dispatch_subscriptions',
      '_smrt_signals',
    ];

    for (const table of tables) {
      // Add column
      await db.execute({
        sql: `ALTER TABLE ${table} ADD COLUMN tenant_id TEXT`
      });

      // Add index
      await db.execute({
        sql: `CREATE INDEX idx_${table}_tenant ON ${table}(tenant_id)`
      });
    }
  },

  down: async (db) => {
    const tables = [
      '_smrt_contexts',
      '_smrt_embeddings',
      '_smrt_dispatch',
      '_smrt_dispatch_subscriptions',
      '_smrt_signals',
    ];

    for (const table of tables) {
      await db.execute({
        sql: `DROP INDEX IF EXISTS idx_${table}_tenant`
      });
      await db.execute({
        sql: `ALTER TABLE ${table} DROP COLUMN tenant_id`
      });
    }
  }
} satisfies Migration;
```

### Core Integration Points

Changes required in `@happyvertical/smrt-core`:

#### SmrtCollection Changes

```typescript
// In packages/core/src/collection.ts

import { getTenantInterceptor } from '@happyvertical/smrt-tenancy';

class SmrtCollection<T extends SmrtObject> {
  async list(options: ListOptions = {}): Promise<T[]> {
    // Apply tenant interceptor
    const interceptor = getTenantInterceptor();
    const filteredOptions = interceptor.beforeList(
      this.itemClassName,
      options
    );

    // ... existing list logic with filteredOptions ...
  }

  async get(id: string): Promise<T | null> {
    const instance = await this._internalGet(id);

    // Validate tenant access
    const interceptor = getTenantInterceptor();
    return interceptor.afterGet(this.itemClassName, instance);
  }
}
```

#### SmrtObject Changes

```typescript
// In packages/core/src/object.ts

import { getTenantInterceptor } from '@happyvertical/smrt-tenancy';

class SmrtObject {
  async save(): Promise<this> {
    // Validate tenant before save
    const interceptor = getTenantInterceptor();
    interceptor.beforeSave(this);

    // ... existing save logic ...
  }

  async delete(): Promise<void> {
    // Validate tenant before delete
    const interceptor = getTenantInterceptor();
    interceptor.beforeDelete(this);

    // ... existing delete logic ...
  }
}
```

## Usage Examples

### Basic Usage

```typescript
import { smrt, SmrtObject } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt()
@TenantScoped()
class Document extends SmrtObject {
  tenantId = tenantId();
  title: string = '';
  content: string = '';
}

// In a request handler (with middleware configured):
const documents = await documentCollection.list({
  where: { status: 'published' }
  // tenantId automatically injected!
});

// Create new document - tenantId auto-populated
const doc = await documentCollection.create({
  title: 'Hello World',
  content: 'This is my document'
});
await doc.save();
// doc.tenantId === current tenant from context
```

### Admin Dashboard (Super Admin)

```typescript
import { withSuperAdminBypass } from '@happyvertical/smrt-tenancy';

// Only in explicitly configured admin routes
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.isSuperAdmin) {
    throw error(403, 'Super admin access required');
  }

  // Explicitly enable bypass for cross-tenant query
  const allTenants = await withSuperAdminBypass(async () => {
    return tenantCollection.list();
  });

  // Regular queries still scoped to admin's selected tenant
  const myDocuments = await documentCollection.list();

  return { allTenants, myDocuments };
};
```

### Database-Per-Tenant (blindmanpress pattern)

```typescript
import {
  configureTenantDatabase,
  getTenantDatabase
} from '@happyvertical/smrt-tenancy';

// Configure at app startup
configureTenantDatabase({
  strategy: 'database-per-tenant',
  resolveConnection: async (tenantId) => {
    // Convention: tenant slug = database name
    return {
      type: 'postgres',
      host: process.env.CNPG_HOST,
      port: parseInt(process.env.CNPG_PORT || '5432'),
      database: tenantId,  // e.g., 'bentleyalberta'
      user: process.env.CNPG_USER,
      password: process.env.CNPG_PASSWORD,
    };
  },
  poolConfig: {
    maxConnections: 5,
    idleTimeoutMs: 30000,
  }
});

// In handlers - automatically routes to correct DB
const db = await getTenantDatabase();
const articles = await db.list('articles', { where: { status: 'published' } });
```

### CLI Context

```typescript
// packages/tenancy/src/adapters/cli.ts
import { withTenant } from '../context.js';
import { resolveTenantContext } from '../integration/users.js';

/**
 * Run CLI command with tenant context
 */
export async function runWithTenant<T>(
  options: {
    db: DatabaseConfig;
    tenantId: string;
    userId?: string;
  },
  fn: () => Promise<T>
): Promise<T> {
  const context = await resolveTenantContext({
    db: options.db,
    userId: options.userId || 'cli-system',
    tenantId: options.tenantId,
  });

  if (!context) {
    throw new Error(`Tenant ${options.tenantId} not found`);
  }

  return withTenant(context, fn);
}

// CLI usage:
// smrt --tenant=bentleyalberta documents:list
```

## Implementation Plan

### Phase 0: smrt-core Interceptor Infrastructure (Week 1)
**Required first to avoid circular dependencies.**
- [ ] Design `CollectionInterceptor` interface in smrt-core
- [ ] Implement `GlobalInterceptors` registry
- [ ] Add interceptor hooks to `SmrtCollection.list()`
- [ ] Add interceptor hooks to `SmrtCollection.get()`
- [ ] Add interceptor hooks to `SmrtCollection.query()` with policy flag
- [ ] Add interceptor hooks to `SmrtObject.save()`
- [ ] Add interceptor hooks to `SmrtObject.delete()`
- [ ] Update schema generator for composite unique constraints
- [ ] Write tests for interceptor infrastructure
- [ ] Document interceptor system in core CLAUDE.md

### Phase 1: Core Tenancy Module (Week 2)
- [ ] Create `@happyvertical/smrt-tenancy` package structure
- [ ] Implement `TenantContext` with AsyncLocalStorage
- [ ] Implement `TenantContext.bind()` for background job context
- [ ] Implement `tenantId()` field helper
- [ ] Implement `@TenantScoped` decorator
- [ ] Implement tenant interceptor (registers with GlobalInterceptors)
- [ ] Add `tenancy` config to ObjectRegistry
- [ ] Write unit tests for context and decorators

### Phase 2: CLI & Test Adapters (Week 2)
**Moved earlier - needed to test enforcement.**
- [ ] Implement CLI adapter (`runWithTenant`)
- [ ] Implement test helpers (`withTestTenant`)
- [ ] Write integration tests using test helpers

### Phase 3: Enforcement & Security (Week 3)
- [ ] Implement query auto-filtering
- [ ] Implement save validation
- [ ] Implement cross-tenant access prevention
- [ ] Implement raw SQL policy (throw on tenant-scoped)
- [ ] Implement `withRawQuery()` escape hatch
- [ ] Implement `withSystemContext()` for admin tools
- [ ] Write security tests (bypass attempts)
- [ ] Write integration tests for enforcement

### Phase 4: smrt-users Integration (Week 3-4)
- [ ] Implement `resolveTenantContext()`
- [ ] Implement permission integration
- [ ] Implement super admin detection
- [ ] Implement `withSuperAdminBypass()` with explicit enable
- [ ] Write tests for user integration

### Phase 5: Database Strategies (Week 4)
- [ ] Implement shared-schema strategy (default)
- [ ] Implement schema-per-tenant strategy
- [ ] Implement database-per-tenant strategy
- [ ] Add connection pool management with cleanup
- [ ] Add `search_path` reset on connection release
- [ ] Add system table migrations (tenant_id columns)

### Phase 6: Framework Adapters (Week 5)
- [ ] Implement SvelteKit adapter
- [ ] Implement Express/Hono middleware
- [ ] Implement agent job context binding
- [ ] Add TypeScript type augmentation for App.Locals

### Phase 7: Migration Tooling (Week 5)
**For adopting tenancy on existing data.**
- [ ] Create `backfillTenantId` utility
- [ ] Support `tenantId({ default: 'legacy' })` for migration period
- [ ] Create migration guide with step-by-step process
- [ ] Test migration on blindmanpress.com

### Phase 8: Documentation & Release (Week 6)
- [ ] Write CLAUDE.md for smrt-tenancy package
- [ ] Write migration guide for existing projects
- [ ] Migrate blindmanpress.com fully to new module
- [ ] Create example project template
- [ ] Update main CLAUDE.md
- [ ] Create GitHub issue templates for tenancy bugs

## Migration Strategy for Existing Data

### Problem
Existing projects (like blindmanpress.com) have data without `tenant_id` columns. We need a smooth migration path.

### Solution: Three-Stage Migration

#### Stage 1: Add Column with Default
```typescript
// Allow null during transition
@smrt()
@TenantScoped({ mode: 'optional' })  // Temporary during migration
class Document extends SmrtObject {
  tenantId = tenantId({
    required: false,           // Allow null temporarily
    default: 'legacy_tenant',  // Default for existing rows
  });
}
```

#### Stage 2: Backfill Data
```typescript
import { backfillTenantIds } from '@happyvertical/smrt-tenancy/migration';

// Run as one-time migration script
await backfillTenantIds({
  db,
  className: 'Document',
  strategy: 'derive',  // or 'constant'
  derive: async (doc) => {
    // Derive tenant from existing relationships
    const project = await projectCollection.get(doc.projectId);
    return project?.tenantId;
  },
  // OR use constant for simple cases
  constant: 'main-tenant-id',
});
```

#### Stage 3: Enable Enforcement
```typescript
// After backfill complete, switch to required
@smrt()
@TenantScoped({ mode: 'required' })  // Full enforcement
class Document extends SmrtObject {
  tenantId = tenantId();  // Now required
}
```

### Denormalization Decision

For objects with indirect tenant relationships (e.g., `Document` → `Project` → `Tenant`):

**Option A: Denormalize (Recommended)**
- Every tenant-scoped object gets its own `tenant_id` column
- Faster queries (no joins needed for filtering)
- Simpler security (single column to check)
- Slightly more storage

**Option B: Inherit from Parent**
- Derive tenant from relationship chain
- Less redundancy
- Slower queries, more complex enforcement
- Risk of inconsistency

**Recommendation:** Denormalize. Storage is cheap; security bugs are expensive.

---

## Security Considerations

1. **Super Admin Bypass Disabled by Default**
   - `allowSuperAdminBypass: false` is the default
   - Must be explicitly enabled per-class
   - Must be explicitly enabled per-route

2. **Cross-Tenant Access Prevention**
   - Queries automatically filtered
   - Saves validated against context
   - Updates checked for tenant ownership
   - Deletes checked for tenant ownership

3. **Context Tampering Prevention**
   - If tenant filter already in query, validated against context
   - Cannot specify different tenant than context

4. **Raw SQL Policy**
   - `collection.query()` throws error on `@TenantScoped` classes by default
   - `withRawQuery()` provides explicit escape hatch with logging
   - `withSystemContext()` for migrations/admin tools only

5. **Connection Pool Isolation**
   - For `schema-per-tenant`: Reset `search_path` on connection release
   - For `database-per-tenant`: Separate pools per tenant
   - Connection verification before reuse

6. **Audit Trail**
   - All operations include tenant context
   - Super admin bypass actions logged with stack trace
   - Raw SQL usage logged with warning

## Alternatives Considered

### 1. PostgreSQL Row-Level Security (RLS)

**Pros:**
- Database-enforced, impossible to bypass
- Works even with raw SQL queries

**Cons:**
- PostgreSQL only
- Complex policy management
- Performance overhead
- Harder to debug

**Decision:** Application-level enforcement first, RLS as future enhancement.

### 2. Middleware-Only Approach

**Pros:**
- Simpler implementation
- No core changes needed

**Cons:**
- Easy to forget in new routes
- No enforcement at model level
- Agents/cron jobs need separate handling

**Decision:** Deep integration provides stronger guarantees.

### 3. Separate Tables Per Tenant

**Pros:**
- Complete data isolation
- Easy backup/restore per tenant

**Cons:**
- Schema drift across tenants
- Complex migrations
- Operational overhead

**Decision:** Support database-per-tenant for those who need it, but not table-per-tenant.

## Open Questions

1. **Caching:** How should tenant context affect caching strategies?
   - Cache keys should include tenant ID
   - Need `TenantCache` wrapper or convention
   - **Status:** Design needed in Phase 5

2. ~~**Background Jobs:** How should agents and cron jobs establish tenant context?~~
   - **RESOLVED:** Use `TenantContext.bind()` for callbacks and `runWithJobContext()` for queue jobs
   - Jobs must include tenant metadata; worker extracts and establishes context

3. **Webhooks:** How should incoming webhooks determine tenant context?
   - Option A: Tenant ID in webhook URL path (`/webhook/{tenantId}/stripe`)
   - Option B: Tenant ID in webhook payload (signed)
   - Option C: Lookup from webhook source (e.g., Stripe customer → tenant mapping)
   - **Status:** Design needed, likely Option A for simplicity

4. **Federation:** How does tenancy interact with gnode federation?
   - Federated requests include source tenant context
   - Cross-gnode data access requires explicit federation grants
   - **Status:** Future RFC needed, out of scope for v1

5. **Composite Foreign Keys:** Should related entities validate tenant consistency?
   - e.g., If `Document.projectId` references a `Project`, should we verify `Project.tenantId === Document.tenantId`?
   - **Status:** Design needed - likely yes for writes, optional for reads

## Appendix: Review Feedback

This RFC was reviewed by Gemini 2.5 Pro with the following critical findings that have been incorporated:

1. ✅ **Circular Dependency** - Fixed with `GlobalInterceptors` registry pattern
2. ✅ **Raw SQL Bypass** - Added three-tier policy (throw, `withRawQuery`, `withSystemContext`)
3. ✅ **Composite Unique Constraints** - Added to schema generation
4. ✅ **Context Loss in Background Jobs** - Added `TenantContext.bind()`
5. ✅ **Implementation Order** - Added Phase 0 for interceptor infrastructure
6. ✅ **Migration Strategy** - Added three-stage migration approach
7. ✅ **Connection Pool State** - Added `search_path` reset on release

## References

- Current blindmanpress.com implementation
- `@happyvertical/smrt-users` package
- Node.js AsyncLocalStorage documentation
- PostgreSQL Row-Level Security
- Gemini 2.5 Pro architectural review
