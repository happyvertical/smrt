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

    it('should be detectable via isSystemContext()', async () => {
      const { isSystemContext } = await import('../context.js');

      // Outside any context
      expect(isSystemContext()).toBe(false);

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        // Inside tenant context
        expect(isSystemContext()).toBe(false);

        await withSystemContext(async () => {
          // Inside system context
          expect(isSystemContext()).toBe(true);
        });

        // Back in tenant context
        expect(isSystemContext()).toBe(false);
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

    it('should bypass mode: required when using withSystemContext (issue #868)', async () => {
      registerTenantScopedClass('Document', { mode: 'required' });
      const interceptor = createTenantInterceptor();

      // This should NOT throw when using withSystemContext
      await withSystemContext(async () => {
        const result = interceptor.beforeList?.(
          'Document',
          { where: {} },
          {
            className: 'Document',
            operation: 'list',
            timestamp: new Date(),
          },
        );

        // Should pass through without adding tenant filter
        expect(result).toBeUndefined();
      });
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

    it('should pass through scalar filter matching context tenant', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        const result = interceptor.beforeList?.(
          'Document',
          { where: { tenantId: 'tenant-123' } },
          {
            className: 'Document',
            operation: 'list',
            timestamp: new Date(),
          },
        );

        // Filter already correct - pass through unchanged
        expect(result).toBeUndefined();
      });
    });

    // Array (IN-style) tenant filters - issue #1495
    it('should allow array filter containing only the context tenant (issue #1495)', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        const result = interceptor.beforeList?.(
          'Document',
          { where: { tenantId: ['tenant-123'] } },
          {
            className: 'Document',
            operation: 'list',
            timestamp: new Date(),
          },
        );

        // Filter already correct - pass through unchanged
        expect(result).toBeUndefined();
      });
    });

    it('should throw on array filter containing only a foreign tenant', async () => {
      registerTenantScopedClass('Document');
      const onIsolationViolation = vi.fn();
      const interceptor = createTenantInterceptor({ onIsolationViolation });

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(() =>
          interceptor.beforeList?.(
            'Document',
            { where: { tenantId: ['different-tenant'] } },
            {
              className: 'Document',
              operation: 'list',
              timestamp: new Date(),
            },
          ),
        ).toThrow(TenantIsolationError);

        // Violation callback reports the offending foreign tenant,
        // not an Array.prototype.toString() of the whole filter
        expect(onIsolationViolation).toHaveBeenCalledWith(
          'Document',
          'tenant-123',
          'different-tenant',
          expect.anything(),
        );
      });
    });

    it('should throw on array filter mixing context and foreign tenants', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(() =>
          interceptor.beforeList?.(
            'Document',
            { where: { tenantId: ['tenant-123', 'different-tenant'] } },
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

  describe('beforeGet', () => {
    it('should convert string ID filter to object with tenant filter', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        const result = interceptor.beforeGet?.('Document', 'doc-1', {
          className: 'Document',
          operation: 'get',
          timestamp: new Date(),
        });

        expect(result).toEqual({ id: 'doc-1', tenantId: 'tenant-123' });
      });
    });

    it('should pass through scalar filter matching context tenant', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        const result = interceptor.beforeGet?.(
          'Document',
          { id: 'doc-1', tenantId: 'tenant-123' },
          {
            className: 'Document',
            operation: 'get',
            timestamp: new Date(),
          },
        );

        expect(result).toBeUndefined();
      });
    });

    it('should throw on scalar foreign tenant filter', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(() =>
          interceptor.beforeGet?.(
            'Document',
            { id: 'doc-1', tenantId: 'different-tenant' },
            {
              className: 'Document',
              operation: 'get',
              timestamp: new Date(),
            },
          ),
        ).toThrow(TenantIsolationError);
      });
    });

    // Array (IN-style) tenant filters - issue #1495
    it('should allow array filter containing only the context tenant (issue #1495)', async () => {
      registerTenantScopedClass('Document');
      const interceptor = createTenantInterceptor();

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        const result = interceptor.beforeGet?.(
          'Document',
          { id: 'doc-1', tenantId: ['tenant-123'] },
          {
            className: 'Document',
            operation: 'get',
            timestamp: new Date(),
          },
        );

        expect(result).toBeUndefined();
      });
    });

    it('should throw on array filter containing a foreign tenant', async () => {
      registerTenantScopedClass('Document');
      const onIsolationViolation = vi.fn();
      const interceptor = createTenantInterceptor({ onIsolationViolation });

      await withTenant({ tenantId: 'tenant-123' }, async () => {
        expect(() =>
          interceptor.beforeGet?.(
            'Document',
            { id: 'doc-1', tenantId: ['different-tenant'] },
            {
              className: 'Document',
              operation: 'get',
              timestamp: new Date(),
            },
          ),
        ).toThrow(TenantIsolationError);

        expect(onIsolationViolation).toHaveBeenCalledWith(
          'Document',
          'tenant-123',
          'different-tenant',
          expect.anything(),
        );

        expect(() =>
          interceptor.beforeGet?.(
            'Document',
            { id: 'doc-1', tenantId: ['tenant-123', 'different-tenant'] },
            {
              className: 'Document',
              operation: 'get',
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

  describe('directory dispatch hooks', () => {
    function createMockDispatchBus() {
      const emitted: Array<{
        type: string;
        payload: unknown;
        options: unknown;
      }> = [];
      return {
        emitted,
        bus: {
          emit: vi.fn(
            async (type: string, payload: unknown, options: unknown) => {
              emitted.push({ type, payload, options });
            },
          ),
        } as any,
      };
    }

    it('should not emit dispatch when dispatchBus not provided (backwards compat)', async () => {
      const interceptor = createTenantInterceptor({
        directoryClasses: ['Membership'],
      });
      const instance = { id: 'mem-1', tenantId: 't-1', userId: 'u-1' } as any;
      const context = {
        className: 'Membership',
        operation: 'save' as const,
        timestamp: new Date(),
        metadata: { _directoryIsNew: true },
      };

      // Should not throw — just silently skip
      await interceptor.afterSave?.(instance, context);
    });

    it('should not emit dispatch for unconfigured classes', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Membership'],
      });
      const instance = { id: 'doc-1', title: 'test' } as any;
      const context = {
        className: 'Document',
        operation: 'save' as const,
        timestamp: new Date(),
      };

      await interceptor.afterSave?.(instance, context);
      expect(emitted).toHaveLength(0);
    });

    it('should emit directory.*.created for new instances', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Membership'],
      });
      const instance = {
        id: 'mem-1',
        tenantId: 't-1',
        userId: 'u-1',
        status: 'active',
      } as any;
      const context = {
        className: 'Membership',
        operation: 'save' as const,
        timestamp: new Date(),
        metadata: { _directoryIsNew: true },
      };

      await interceptor.afterSave?.(instance, context);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe('directory.membership.created');
      expect(emitted[0].payload).toMatchObject({
        className: 'Membership',
        id: 'mem-1',
        tenantId: 't-1',
        userId: 'u-1',
      });
      expect(emitted[0].options).toMatchObject({
        source: 'smrt-tenancy',
        sourceId: 'mem-1',
      });
    });

    it('should emit directory.*.updated for existing instances', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Membership'],
      });
      const instance = {
        id: 'mem-1',
        tenantId: 't-1',
        userId: 'u-1',
        status: 'suspended',
      } as any;
      const context = {
        className: 'Membership',
        operation: 'save' as const,
        timestamp: new Date(),
        metadata: { _directoryIsNew: false },
      };

      await interceptor.afterSave?.(instance, context);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe('directory.membership.updated');
    });

    it('should detect isNew via beforeSave metadata stashing', () => {
      const { bus } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Tenant'],
      });

      // New instance (no id)
      const newInstance = { name: 'Acme Corp' } as any;
      const newContext = {
        className: 'Tenant',
        operation: 'save' as const,
        timestamp: new Date(),
      };
      interceptor.beforeSave?.(newInstance, newContext);
      expect(newContext.metadata?._directoryIsNew).toBe(true);

      // Existing instance (has id)
      const existingInstance = { id: 'tenant-1', name: 'Acme Corp' } as any;
      const existingContext = {
        className: 'Tenant',
        operation: 'save' as const,
        timestamp: new Date(),
      };
      interceptor.beforeSave?.(existingInstance, existingContext);
      expect(existingContext.metadata?._directoryIsNew).toBe(false);
    });

    it('should not stash isNew for unconfigured classes', () => {
      const { bus } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Membership'],
      });

      const instance = { name: 'test doc' } as any;
      const context = {
        className: 'Document',
        operation: 'save' as const,
        timestamp: new Date(),
      };
      interceptor.beforeSave?.(instance, context);
      expect(context.metadata?._directoryIsNew).toBeUndefined();
    });

    it('should emit directory.*.deleted on afterDelete', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Membership'],
      });
      const instance = {
        id: 'mem-1',
        tenantId: 't-1',
        userId: 'u-1',
      } as any;
      const context = {
        className: 'Membership',
        operation: 'delete' as const,
        timestamp: new Date(),
      };

      await interceptor.afterDelete?.(instance, context);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe('directory.membership.deleted');
      expect(emitted[0].payload).toMatchObject({
        className: 'Membership',
        id: 'mem-1',
      });
      expect(emitted[0].options).toMatchObject({
        source: 'smrt-tenancy',
        sourceId: 'mem-1',
      });
    });

    it('should not emit delete dispatch for unconfigured classes', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Membership'],
      });
      const instance = { id: 'doc-1' } as any;
      const context = {
        className: 'Document',
        operation: 'delete' as const,
        timestamp: new Date(),
      };

      await interceptor.afterDelete?.(instance, context);
      expect(emitted).toHaveLength(0);
    });

    it('should not emit delete dispatch when dispatchBus not provided', async () => {
      const interceptor = createTenantInterceptor({
        directoryClasses: ['Membership'],
      });
      const instance = { id: 'mem-1' } as any;
      const context = {
        className: 'Membership',
        operation: 'delete' as const,
        timestamp: new Date(),
      };

      // Should not throw
      await interceptor.afterDelete?.(instance, context);
    });

    it('should serialize instance without functions', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Tenant'],
      });
      const instance = {
        id: 'tenant-1',
        name: 'Acme',
        slug: 'acme',
        save: () => {},
        validate: () => {},
      } as any;
      const context = {
        className: 'Tenant',
        operation: 'save' as const,
        timestamp: new Date(),
        metadata: { _directoryIsNew: true },
      };

      await interceptor.afterSave?.(instance, context);

      const payload = emitted[0].payload as Record<string, unknown>;
      expect(payload.id).toBe('tenant-1');
      expect(payload.name).toBe('Acme');
      expect(payload.className).toBe('Tenant');
      expect(payload.save).toBeUndefined();
      expect(payload.validate).toBeUndefined();
    });

    it('should produce JSON-serializable payload when instance has circular _db handle (issue #946)', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Membership'],
      });

      // Simulate a real SmrtObject with a _db handle containing
      // circular references (connection pool with Timeout objects)
      const circularPool: Record<string, unknown> = {};
      const timeout = { _idlePrev: circularPool };
      circularPool._idleNext = timeout;
      timeout._idlePrev = circularPool; // circular!

      const instance = {
        id: 'mem-1',
        tenantId: 't-1',
        userId: 'u-1',
        status: 'active',
        // Internal framework handles that cause the crash
        _db: { pool: circularPool },
        _ai: { client: {} },
        _fs: { adapter: {} },
        // toJSON() returns only data fields, like a real SmrtObject
        toJSON() {
          return {
            id: this.id,
            tenantId: this.tenantId,
            userId: this.userId,
            status: this.status,
          };
        },
      } as any;

      const context = {
        className: 'Membership',
        operation: 'save' as const,
        timestamp: new Date(),
        metadata: { _directoryIsNew: true },
      };

      await interceptor.afterSave?.(instance, context);

      expect(emitted).toHaveLength(1);

      const payload = emitted[0].payload as Record<string, unknown>;
      expect(payload.className).toBe('Membership');
      expect(payload.id).toBe('mem-1');
      expect(payload.userId).toBe('u-1');

      // The critical assertion: payload must be JSON-serializable
      // (this is what DispatchBus.emit() does internally)
      expect(() => JSON.stringify(payload)).not.toThrow();

      // Internal handles must NOT leak into the payload
      expect(payload._db).toBeUndefined();
      expect(payload._ai).toBeUndefined();
      expect(payload._fs).toBeUndefined();
    });

    it('should fall back to Object.keys when toJSON is not available', async () => {
      const { bus, emitted } = createMockDispatchBus();
      const interceptor = createTenantInterceptor({
        dispatchBus: bus,
        directoryClasses: ['Tenant'],
      });

      // Plain object stub without toJSON (backwards compat)
      const instance = {
        id: 'tenant-1',
        name: 'Acme',
        status: 'active',
      } as any;

      const context = {
        className: 'Tenant',
        operation: 'save' as const,
        timestamp: new Date(),
        metadata: { _directoryIsNew: true },
      };

      await interceptor.afterSave?.(instance, context);

      const payload = emitted[0].payload as Record<string, unknown>;
      expect(payload.className).toBe('Tenant');
      expect(payload.id).toBe('tenant-1');
      expect(payload.name).toBe('Acme');
    });
  });
});
