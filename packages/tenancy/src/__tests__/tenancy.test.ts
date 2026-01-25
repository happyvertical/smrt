/**
 * Tests for @happyvertical/smrt-tenancy
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Context tests
import {
  getCurrentTenant,
  getTenantId,
  hasTenantContext,
  isSuperAdminBypass,
  requireTenant,
  requireTenantId,
  TenantContext,
  TenantContextError,
  TenantIsolationError,
  withSuperAdminBypass,
  withSystemContext,
  withTenant,
  withTenantSync,
} from '../context';
// Decorator tests
import { TenantScoped } from '../decorators';
// Field tests
import { getTenantIdFieldOptions, isTenantIdField } from '../fields';
// Interceptor tests
import {
  createTenantInterceptor,
  disableTenancy,
  enableTenancy,
  isTenancyEnabled,
} from '../interceptor';
// Registry tests
import {
  clearTenantScopedRegistry,
  getAllTenantScopedClasses,
  getTenantScopedConfig,
  isTenantScopedClass,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry';

// ─────────────────────────────────────────────────────────────────────────────
// Context Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantContext', () => {
  describe('basic context operations', () => {
    it('should return undefined when no context is set', () => {
      expect(getCurrentTenant()).toBeUndefined();
      expect(getTenantId()).toBeUndefined();
      expect(hasTenantContext()).toBe(false);
    });

    it('should provide context within withTenant', async () => {
      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(hasTenantContext()).toBe(true);
        expect(getTenantId()).toBe('tenant-123');
        expect(getCurrentTenant()?.tenantId).toBe('tenant-123');
      });
    });

    it('should clear context after withTenant completes', async () => {
      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(getTenantId()).toBe('tenant-123');
      });

      expect(getTenantId()).toBeUndefined();
    });

    it('should work with sync version', () => {
      withTenantSync({ tenantId: 'tenant-sync' }, () => {
        expect(getTenantId()).toBe('tenant-sync');
      });
    });

    it('should nest contexts correctly', async () => {
      await withTenant({ tenantId: 'outer' }, async () => {
        expect(getTenantId()).toBe('outer');

        await withTenant({ tenantId: 'inner' }, async () => {
          expect(getTenantId()).toBe('inner');
        });

        expect(getTenantId()).toBe('outer');
      });
    });
  });

  describe('requireTenant / requireTenantId', () => {
    it('should throw TenantContextError when no context', () => {
      expect(() => requireTenant()).toThrow(TenantContextError);
      expect(() => requireTenantId()).toThrow(TenantContextError);
    });

    it('should return context when available', async () => {
      await withTenant({ tenantId: 'tenant-456' }, async () => {
        expect(requireTenantId()).toBe('tenant-456');
        expect(requireTenant().tenantId).toBe('tenant-456');
      });
    });
  });

  describe('withSystemContext', () => {
    it('should run without tenant context', async () => {
      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(hasTenantContext()).toBe(true);

        await withSystemContext(async () => {
          // Inside system context, tenant context is cleared
          expect(hasTenantContext()).toBe(false);
          expect(getTenantId()).toBeUndefined();
        });

        // After system context, original context restored
        expect(getTenantId()).toBe('tenant-123');
      });
    });
  });

  describe('withSuperAdminBypass', () => {
    it('should enable super admin bypass', async () => {
      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(isSuperAdminBypass()).toBe(false);

        await withSuperAdminBypass(async () => {
          expect(isSuperAdminBypass()).toBe(true);
          expect(getTenantId()).toBe('tenant-123'); // Still has tenant
        });

        expect(isSuperAdminBypass()).toBe(false);
      });
    });

    it('should throw if no tenant context', async () => {
      await expect(withSuperAdminBypass(async () => {})).rejects.toThrow(
        TenantContextError,
      );
    });
  });

  describe('TenantContext.bind', () => {
    it('should preserve context across async boundaries', async () => {
      await withTenant({ tenantId: 'bound-tenant' }, async () => {
        const boundFn = TenantContext.bind(() => {
          return getTenantId();
        });

        // Run outside context - bound function should still have access
        await withSystemContext(async () => {
          const result = boundFn();
          expect(result).toBe('bound-tenant');
        });
      });
    });

    it('should return function as-is when no context', () => {
      const fn = () => 'test';
      const bound = TenantContext.bind(fn);
      expect(bound()).toBe('test');
    });
  });

  describe('TenantContext.runWithJobContext', () => {
    it('should extract tenantId from job metadata', async () => {
      const job = { metadata: { tenantId: 'job-tenant' } };

      await TenantContext.runWithJobContext(job, async () => {
        expect(getTenantId()).toBe('job-tenant');
      });
    });

    it('should extract tenantId from top-level', async () => {
      const job = { tenantId: 'top-level-tenant' };

      await TenantContext.runWithJobContext(job, async () => {
        expect(getTenantId()).toBe('top-level-tenant');
      });
    });

    it('should throw if job has no tenant info', async () => {
      const job = { data: 'no tenant' };

      await expect(
        TenantContext.runWithJobContext(job, async () => {}),
      ).rejects.toThrow(TenantContextError);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantScopedRegistry', () => {
  beforeEach(() => {
    clearTenantScopedRegistry();
  });

  afterEach(() => {
    clearTenantScopedRegistry();
  });

  it('should register and check tenant-scoped classes', () => {
    expect(isTenantScopedClass('Document')).toBe(false);

    registerTenantScopedClass('Document');

    expect(isTenantScopedClass('Document')).toBe(true);
  });

  it('should return config for registered classes', () => {
    registerTenantScopedClass('Document', {
      mode: 'optional',
      field: 'tenant_id',
    });

    const config = getTenantScopedConfig('Document');
    expect(config).toBeDefined();
    expect(config?.mode).toBe('optional');
    expect(config?.field).toBe('tenant_id');
    expect(config?.autoFilter).toBe(true); // Default
  });

  it('should return undefined for unregistered classes', () => {
    expect(getTenantScopedConfig('Unknown')).toBeUndefined();
  });

  it('should unregister classes', () => {
    registerTenantScopedClass('Document');
    expect(isTenantScopedClass('Document')).toBe(true);

    unregisterTenantScopedClass('Document');
    expect(isTenantScopedClass('Document')).toBe(false);
  });

  it('should list all registered classes', () => {
    registerTenantScopedClass('Document');
    registerTenantScopedClass('Task');

    const all = getAllTenantScopedClasses();
    expect(all.size).toBe(2);
    expect(all.has('Document')).toBe(true);
    expect(all.has('Task')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decorator Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('@TenantScoped decorator', () => {
  beforeEach(() => {
    clearTenantScopedRegistry();
  });

  afterEach(() => {
    clearTenantScopedRegistry();
  });

  it('should register class with default config', () => {
    @TenantScoped()
    class TestDoc {}

    expect(isTenantScopedClass('TestDoc')).toBe(true);
    const config = getTenantScopedConfig('TestDoc');
    expect(config?.mode).toBe('required');
    expect(config?.field).toBe('tenantId');
    expect(config?.autoFilter).toBe(true);
    expect(config?.autoPopulate).toBe(true);
    expect(config?.allowSuperAdminBypass).toBe(false);
  });

  it('should register class with custom config', () => {
    @TenantScoped({
      mode: 'optional',
      field: 'tenant_id',
      allowSuperAdminBypass: true,
    })
    class CustomDoc {}

    const config = getTenantScopedConfig('CustomDoc');
    expect(config?.mode).toBe('optional');
    expect(config?.field).toBe('tenant_id');
    expect(config?.allowSuperAdminBypass).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Field Utility Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('field utilities', () => {
  it('should identify tenant ID fields by __tenancy marker', () => {
    const validField = {
      type: 'foreignKey',
      __tenancy: { isTenantIdField: true, autoFilter: true },
    };
    expect(isTenantIdField(validField)).toBe(true);

    expect(isTenantIdField({ type: 'text' })).toBe(false);
    expect(isTenantIdField(null)).toBe(false);
    expect(isTenantIdField('string')).toBe(false);
  });

  it('should return tenancy options from field definition', () => {
    const field = {
      type: 'foreignKey',
      __tenancy: {
        isTenantIdField: true,
        autoFilter: false,
        nullable: true,
        autoPopulate: true,
      },
    };
    const opts = getTenantIdFieldOptions(field);

    expect(opts?.autoFilter).toBe(false);
    expect(opts?.nullable).toBe(true);
    expect(opts?.autoPopulate).toBe(true);
  });

  it('should return null for non-tenant fields', () => {
    expect(getTenantIdFieldOptions({ type: 'text' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interceptor Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantInterceptor', () => {
  beforeEach(() => {
    disableTenancy();
    clearTenantScopedRegistry();
  });

  afterEach(() => {
    disableTenancy();
    clearTenantScopedRegistry();
  });

  describe('enableTenancy / disableTenancy', () => {
    it('should track enabled state', () => {
      expect(isTenancyEnabled()).toBe(false);

      enableTenancy();
      expect(isTenancyEnabled()).toBe(true);

      disableTenancy();
      expect(isTenancyEnabled()).toBe(false);
    });

    it('should warn when called twice', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      enableTenancy();
      enableTenancy(); // Should warn

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('createTenantInterceptor', () => {
    it('should create interceptor with name and priority', () => {
      const interceptor = createTenantInterceptor();

      expect(interceptor.name).toBe('smrt-tenancy');
      expect(interceptor.priority).toBe(100);
    });

    it('should have all hook methods', () => {
      const interceptor = createTenantInterceptor();

      expect(typeof interceptor.beforeList).toBe('function');
      expect(typeof interceptor.beforeGet).toBe('function');
      expect(typeof interceptor.beforeQuery).toBe('function');
      expect(typeof interceptor.beforeSave).toBe('function');
      expect(typeof interceptor.beforeDelete).toBe('function');
    });
  });

  describe('beforeList', () => {
    it('should pass through for non-tenant-scoped classes', () => {
      const interceptor = createTenantInterceptor();

      const result = interceptor.beforeList?.(
        'RegularClass',
        { where: { status: 'active' } },
        {
          className: 'RegularClass',
          operation: 'list',
          timestamp: new Date(),
        },
      );

      expect(result).toBeUndefined(); // Pass through
    });

    it('should add tenant filter for tenant-scoped classes', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        const result = interceptor.beforeList?.(
          'Document',
          { where: { status: 'active' } },
          {
            className: 'Document',
            operation: 'list',
            timestamp: new Date(),
          },
        );

        expect(result).toBeDefined();
        expect((result as any).where.tenantId).toBe('tenant-123');
        expect((result as any).where.status).toBe('active');
      });
    });

    it('should throw when context required but missing', () => {
      registerTenantScopedClass('Document', { mode: 'required' });
      const interceptor = createTenantInterceptor();

      expect(() =>
        interceptor.beforeList?.(
          'Document',
          { where: {} },
          {
            className: 'Document',
            operation: 'list',
            timestamp: new Date(),
          },
        ),
      ).toThrow(TenantContextError);
    });

    it('should pass through for optional mode without context', () => {
      registerTenantScopedClass('Document', { mode: 'optional' });
      const interceptor = createTenantInterceptor();

      const result = interceptor.beforeList?.(
        'Document',
        { where: {} },
        {
          className: 'Document',
          operation: 'list',
          timestamp: new Date(),
        },
      );

      expect(result).toBeUndefined(); // Pass through
    });

    it('should throw on tenant mismatch in filter', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(() =>
          interceptor.beforeList?.(
            'Document',
            { where: { tenantId: 'different-tenant' } },
            {
              className: 'Document',
              operation: 'list',
              timestamp: new Date(),
            },
          ),
        ).toThrow(TenantIsolationError);
      });
    });
  });

  describe('beforeSave', () => {
    it('should auto-populate tenant ID', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();
      const instance = { tenantId: '' } as any;

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        interceptor.beforeSave?.(instance, {
          className: 'Document',
          operation: 'save',
          timestamp: new Date(),
        });

        expect(instance.tenantId).toBe('tenant-123');
      });
    });

    it('should throw on tenant mismatch', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();
      const instance = {
        constructor: { name: 'Document' },
        tenantId: 'other-tenant',
      } as any;

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(() =>
          interceptor.beforeSave?.(instance, {
            className: 'Document',
            operation: 'save',
            timestamp: new Date(),
          }),
        ).toThrow(TenantIsolationError);
      });
    });
  });

  describe('beforeQuery (raw SQL)', () => {
    it('should throw by default on tenant-scoped class', () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor({ rawQueryPolicy: 'throw' });

      expect(() =>
        interceptor.beforeQuery?.(
          'Document',
          {
            sql: 'SELECT * FROM documents',
            params: [],
            allowRawOnTenantScoped: false,
          },
          {
            className: 'Document',
            operation: 'query',
            timestamp: new Date(),
          },
        ),
      ).toThrow(TenantIsolationError);
    });

    it('should allow with explicit bypass', () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor({ rawQueryPolicy: 'throw' });

      expect(() =>
        interceptor.beforeQuery?.(
          'Document',
          {
            sql: 'SELECT * FROM documents',
            params: [],
            allowRawOnTenantScoped: true,
          },
          {
            className: 'Document',
            operation: 'query',
            timestamp: new Date(),
          },
        ),
      ).not.toThrow();
    });

    it('should warn with warn policy', () => {
      registerTenantScopedClass('Document');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const interceptor = createTenantInterceptor({ rawQueryPolicy: 'warn' });

      interceptor.beforeQuery?.(
        'Document',
        {
          sql: 'SELECT * FROM documents',
          params: [],
          allowRawOnTenantScoped: false,
        },
        {
          className: 'Document',
          operation: 'query',
          timestamp: new Date(),
        },
      );

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
