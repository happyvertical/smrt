import {
  type InterceptorContext,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TenantContextError,
  TenantIsolationError,
  withSystemContext,
  withTenant,
} from '../context.js';
import { TenantScoped } from '../decorators.js';
import { createTenantInterceptor } from '../interceptor.js';
import {
  clearTenantScopedRegistry,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';

const TENANT = 'tenant-2792';
const OTHER_TENANT = 'other-tenant-2792';
const OWNER = '@fixture/2792-owner:Document';
const PEER = '@fixture/2792-peer:Document';

function context(
  operation: InterceptorContext['operation'],
  qualifiedClassName = OWNER,
): InterceptorContext {
  return {
    className: 'Document',
    qualifiedClassName,
    operation,
    timestamp: new Date(),
  };
}

function registerOwner(): void {
  @smrt({
    packageName: '@fixture/2792-owner',
    tableName: 'owner_documents_2792',
  })
  class Document extends SmrtObject {}
}

function registerPeer(): void {
  @smrt({ packageName: '@fixture/2792-peer', tableName: 'peer_documents_2792' })
  class Document extends SmrtObject {}
}

describe('direct tenant registration resolves qualified core identity (#2792)', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    clearTenantScopedRegistry();
  });

  afterEach(() => {
    ObjectRegistry.clear();
    clearTenantScopedRegistry();
  });

  for (const order of ['before-core', 'after-core'] as const) {
    it(`${order} registration enforces every qualified interceptor hook`, async () => {
      if (order === 'before-core') {
        registerTenantScopedClass('Document');
        registerOwner();
      } else {
        registerOwner();
        registerTenantScopedClass('Document');
      }

      expect(ObjectRegistry.getClassByQualifiedName(OWNER)?.name).toBe(
        'Document',
      );
      const interceptor = createTenantInterceptor();

      expect(() =>
        interceptor.beforeList?.('Document', {}, context('list')),
      ).toThrow(TenantContextError);
      expect(() =>
        interceptor.beforeGet?.('Document', 'visible', context('get')),
      ).toThrow(TenantContextError);
      expect(() =>
        interceptor.beforeSave?.(
          { tenantId: '' } as SmrtObject,
          context('save'),
        ),
      ).toThrow(TenantContextError);

      await withTenant({ tenantId: TENANT }, async () => {
        expect(
          interceptor.beforeList?.('Document', {}, context('list')),
        ).toEqual({
          where: { tenantId: TENANT },
        });
        expect(
          interceptor.beforeGet?.('Document', 'visible', context('get')),
        ).toEqual({ slug: 'visible', context: '', tenantId: TENANT });

        const own = { tenantId: '' } as SmrtObject;
        interceptor.beforeSave?.(own, context('save'));
        expect((own as unknown as { tenantId: string }).tenantId).toBe(TENANT);

        expect(() =>
          interceptor.beforeList?.(
            'Document',
            { where: { tenantId: OTHER_TENANT } },
            context('list'),
          ),
        ).toThrow(TenantIsolationError);
        expect(() =>
          interceptor.beforeGet?.(
            'Document',
            { tenantId: OTHER_TENANT },
            context('get'),
          ),
        ).toThrow(TenantIsolationError);
        expect(() =>
          interceptor.beforeSave?.(
            { tenantId: OTHER_TENANT } as SmrtObject,
            context('save'),
          ),
        ).toThrow(TenantIsolationError);
        expect(() =>
          interceptor.beforeQuery?.(
            'Document',
            { sql: 'select * from owner_documents_2792', params: [] },
            context('query'),
          ),
        ).toThrow(TenantIsolationError);
      });
    });
  }

  it('keeps a uniquely resolved direct registration bound when a same-name peer arrives', async () => {
    registerOwner();
    registerTenantScopedClass('Document');
    registerPeer();
    const interceptor = createTenantInterceptor();

    await withTenant({ tenantId: TENANT }, async () => {
      expect(interceptor.beforeList?.('Document', {}, context('list'))).toEqual(
        {
          where: { tenantId: TENANT },
        },
      );
      expect(
        interceptor.beforeList?.('Document', {}, context('list', PEER)),
      ).toBeUndefined();
    });
  });

  it('keeps decorator mirrors exact for same-name package peers', () => {
    let required: typeof SmrtObject;
    {
      @smrt({ packageName: '@fixture/2792-decorator-required' })
      @TenantScoped({ mode: 'required' })
      class DecoratedDocument extends SmrtObject {}
      required = DecoratedDocument;
    }
    {
      @smrt({ packageName: '@fixture/2792-decorator-optional' })
      @TenantScoped({ mode: 'optional' })
      class DecoratedDocument extends SmrtObject {}
    }

    const qualified =
      ObjectRegistry.getClassByConstructor(required)?.qualifiedName;
    expect(qualified).toBe(
      '@fixture/2792-decorator-required:DecoratedDocument',
    );
    const interceptor = createTenantInterceptor();
    expect(() =>
      interceptor.beforeList?.(
        'DecoratedDocument',
        {},
        {
          ...context('list'),
          className: 'DecoratedDocument',
          qualifiedClassName: qualified,
        },
      ),
    ).toThrow(TenantContextError);
    expect(
      interceptor.beforeList?.(
        'DecoratedDocument',
        {},
        {
          ...context('list'),
          className: 'DecoratedDocument',
          qualifiedClassName:
            '@fixture/2792-decorator-optional:DecoratedDocument',
        },
      ),
    ).toBeUndefined();
  });

  it.each([
    'tenant-first',
    'smrt-first',
  ] as const)('keeps explicit required core policy over an optional decorator (%s)', async (order) => {
    let Document: typeof SmrtObject;
    if (order === 'tenant-first') {
      @smrt({
        packageName: `@fixture/2792-${order}`,
        tenantScoped: { mode: 'required' },
      })
      @TenantScoped({ mode: 'optional' })
      class RequiredDocument extends SmrtObject {}
      Document = RequiredDocument;
    } else {
      @TenantScoped({ mode: 'optional' })
      @smrt({
        packageName: `@fixture/2792-${order}`,
        tenantScoped: { mode: 'required' },
      })
      class RequiredDocument extends SmrtObject {}
      Document = RequiredDocument;
    }
    const interceptor = createTenantInterceptor();
    expect(() =>
      interceptor.beforeList?.(
        'RequiredDocument',
        {},
        {
          ...context('list'),
          className: 'RequiredDocument',
          qualifiedClassName: undefined,
        },
      ),
    ).toThrow(TenantContextError);
    await withTenant({ tenantId: TENANT }, async () => {
      expect(
        interceptor.beforeList?.(
          'RequiredDocument',
          {},
          {
            ...context('list'),
            className: 'RequiredDocument',
            qualifiedClassName: undefined,
          },
        ),
      ).toEqual({ where: { tenantId: TENANT } });
      expect(() =>
        interceptor.beforeList?.(
          'RequiredDocument',
          { where: { tenantId: OTHER_TENANT } },
          {
            ...context('list'),
            className: 'RequiredDocument',
            qualifiedClassName: undefined,
          },
        ),
      ).toThrow(TenantIsolationError);
    });
  });

  it('keeps explicit core false over a required decorator for simple lookup', () => {
    @TenantScoped({ mode: 'required' })
    @smrt({ packageName: '@fixture/2792-explicit-false', tenantScoped: false })
    class GlobalDocument extends SmrtObject {}
    const interceptor = createTenantInterceptor();
    expect(
      interceptor.beforeList?.(
        'GlobalDocument',
        {},
        {
          ...context('list'),
          className: 'GlobalDocument',
          qualifiedClassName: undefined,
        },
      ),
    ).toBeUndefined();
  });

  it('inherits a bound direct registration without stripping an ancestor namespace', async () => {
    registerTenantScopedClass('DirectBase2792');
    @smrt({ packageName: '@fixture/2792-inheritance', tableStrategy: 'sti' })
    class DirectBase2792 extends SmrtObject {}
    @smrt({ packageName: '@fixture/2792-inheritance' })
    class DirectChild2792 extends DirectBase2792 {}

    const child =
      ObjectRegistry.getClassByConstructor(DirectChild2792)?.qualifiedName;
    expect(child).toBe('@fixture/2792-inheritance:DirectChild2792');
    const interceptor = createTenantInterceptor();
    await withTenant({ tenantId: TENANT }, async () => {
      expect(
        interceptor.beforeList?.(
          'DirectChild2792',
          {},
          {
            ...context('list'),
            className: 'DirectChild2792',
            qualifiedClassName: child,
          },
        ),
      ).toEqual({ where: { tenantId: TENANT } });
    });
  });

  it('fails closed for an ambiguous pending simple selector until explicitly qualified', async () => {
    registerTenantScopedClass('Document');
    registerOwner();
    registerPeer();
    const interceptor = createTenantInterceptor();

    await withTenant({ tenantId: TENANT }, async () => {
      expect(() =>
        interceptor.beforeList?.('Document', {}, context('list')),
      ).toThrow(/Ambiguous tenant-scoped class registration 'Document'/);
      expect(() =>
        interceptor.beforeList?.('Document', {}, context('list', PEER)),
      ).toThrow(/Ambiguous tenant-scoped class registration 'Document'/);
    });

    unregisterTenantScopedClass('Document');
    registerTenantScopedClass(OWNER);
    await withTenant({ tenantId: TENANT }, async () => {
      expect(interceptor.beforeList?.('Document', {}, context('list'))).toEqual(
        {
          where: { tenantId: TENANT },
        },
      );
      expect(
        interceptor.beforeList?.('Document', {}, context('list', PEER)),
      ).toBeUndefined();
    });
  });

  it('updates and removes the exact binding on overwrite, unregister, and reset', async () => {
    registerOwner();
    registerTenantScopedClass('Document');
    registerTenantScopedClass('Document', { mode: 'optional' });
    const interceptor = createTenantInterceptor();

    expect(
      interceptor.beforeList?.('Document', {}, context('list')),
    ).toBeUndefined();

    unregisterTenantScopedClass('Document');
    expect(
      interceptor.beforeList?.('Document', {}, context('list')),
    ).toBeUndefined();

    registerTenantScopedClass('Document');
    clearTenantScopedRegistry();
    expect(
      interceptor.beforeList?.('Document', {}, context('list')),
    ).toBeUndefined();
  });

  it('fails closed when core reuses a bound qualified name for a new constructor', async () => {
    registerOwner();
    registerTenantScopedClass('Document', { mode: 'optional' });
    ObjectRegistry.clear();
    registerOwner();
    const interceptor = createTenantInterceptor();

    expect(() =>
      interceptor.beforeList?.('Document', {}, context('list')),
    ).toThrow(/Stale tenant-scoped class registration 'Document'/);
    expect(() =>
      interceptor.beforeList?.(
        'Document',
        {},
        {
          ...context('list'),
          qualifiedClassName: undefined,
        },
      ),
    ).toThrow(/Stale tenant-scoped class registration 'Document'/);

    unregisterTenantScopedClass('Document');
    registerTenantScopedClass('Document');
    await withTenant({ tenantId: TENANT }, async () => {
      expect(interceptor.beforeList?.('Document', {}, context('list'))).toEqual(
        {
          where: { tenantId: TENANT },
        },
      );
      expect(
        interceptor.beforeList?.(
          'Document',
          {},
          {
            ...context('list'),
            qualifiedClassName: undefined,
          },
        ),
      ).toEqual({ where: { tenantId: TENANT } });
    });
  });

  it('keeps the explicit system-context bypass for a bound qualified class', async () => {
    registerOwner();
    registerTenantScopedClass('Document');
    const interceptor = createTenantInterceptor();

    await withSystemContext(async () => {
      expect(
        interceptor.beforeList?.('Document', {}, context('list')),
      ).toBeUndefined();
      expect(
        interceptor.beforeGet?.('Document', 'visible', context('get')),
      ).toBeUndefined();
      const instance = { tenantId: '' } as SmrtObject;
      interceptor.beforeSave?.(instance, context('save'));
      expect((instance as unknown as { tenantId: string }).tenantId).toBe('');
      expect(
        interceptor.beforeQuery?.(
          'Document',
          { sql: 'select * from owner_documents_2792', params: [] },
          context('query'),
        ),
      ).toBeUndefined();
    });
  });
});
