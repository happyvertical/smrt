import { createInterceptorContext } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCurrentTenant,
  isSystemContext,
  withSystemContext,
  withTenant,
} from '../context';
import {
  createTenantInterceptor,
  disableTenancy,
  enableTenancy,
} from '../interceptor';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry';
import { withTenantGlobalRead } from '../tenant-global-queries';
import { runTenantHierarchyReadScope } from '../tenant-hierarchy-read-scope';

const name = 'TenantGlobalCapabilityProbe';
const context = createInterceptorContext(name, 'list');
const interceptor = createTenantInterceptor();
const read = (
  where: Record<string, unknown> | Record<string, unknown>[][] = {},
) => interceptor.beforeList?.(name, { where }, context);

describe('tenant/global list capability', () => {
  beforeEach(() => {
    registerTenantScopedClass(name, { mode: 'required' });
    enableTenancy();
  });
  afterEach(() => {
    unregisterTenantScopedClass(name);
    disableTenancy();
  });

  it('ANDs object and DNF filters with the allowed scope without changing actors', async () => {
    await withTenant(
      { tenantId: 'a', userId: 'reader', permissions: new Set(['read']) },
      async () => {
        const actor = getCurrentTenant();
        await withTenantGlobalRead('a', async () => {
          expect(isSystemContext()).toBe(false);
          expect(getCurrentTenant()).toBe(actor);
          expect(await read({ category: 'keep' })).toMatchObject({
            where: [
              [{ category: 'keep' }, { tenantId: 'a' }],
              [{ category: 'keep' }, { tenantId: null }],
            ],
          });
          expect(await read([[{ tenantId: 'b' }]])).toMatchObject({
            where: [
              [{ tenantId: 'b' }, { tenantId: 'a' }],
              [{ tenantId: 'b' }, { tenantId: null }],
            ],
          });
          // The list capability does not authorize a global point read.
          expect(() =>
            interceptor.beforeGet?.(name, { tenantId: null }, context),
          ).toThrow();
          await expect(
            withTenant({ tenantId: 'b' }, async () => read()),
          ).rejects.toThrow();
        });
        expect(await read()).toMatchObject({ where: { tenantId: 'a' } });
        await expect(
          withTenantGlobalRead('b', async () => read()),
        ).rejects.toThrow();
      },
    );
  });

  it('restores after rejection and isolates concurrent capabilities', async () => {
    const result = await Promise.all(
      ['a', 'b'].map((tenantId) =>
        withTenantGlobalRead(tenantId, async () => {
          await Promise.resolve();
          expect(isSystemContext()).toBe(false);
          return read();
        }),
      ),
    );
    expect(result[0]).toMatchObject({
      where: [
        [{}, { tenantId: 'a' }],
        [{}, { tenantId: null }],
      ],
    });
    expect(result[1]).toMatchObject({
      where: [
        [{}, { tenantId: 'b' }],
        [{}, { tenantId: null }],
      ],
    });
    await expect(
      withTenantGlobalRead('a', async () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    expect(() => read()).toThrow('Tenant context required');
    await expect(withTenantGlobalRead('', async () => read())).rejects.toThrow(
      'nonempty',
    );
    await withSystemContext(async () => {
      await withTenantGlobalRead('a', async () => {
        expect(isSystemContext()).toBe(true);
        expect(await read()).toBeUndefined();
      });
    });
  });

  it('rejects a hierarchy capability before callback when tenancy is disabled', async () => {
    disableTenancy();
    let called = false;
    await expect(
      runTenantHierarchyReadScope(
        {
          actorTenantId: 'family',
          actorUserId: 'guardian',
          collections: [name],
          includeGlobal: true,
          tenantIds: ['family'],
        },
        async () => {
          called = true;
        },
      ),
    ).rejects.toThrow('requires enableTenancy()');
    expect(called).toBe(false);
  });

  it('limits trusted hierarchy scope to one allowlisted list read and restores on failure', async () => {
    await withTenant(
      {
        tenantId: 'family',
        userId: 'guardian',
        permissions: new Set(['read']),
      },
      async () => {
        await runTenantHierarchyReadScope(
          {
            actorTenantId: 'family',
            actorUserId: 'guardian',
            collections: [name],
            includeGlobal: true,
            tenantIds: ['family', 'group'],
          },
          async () => {
            expect(await read({ category: 'keep' })).toMatchObject({
              where: [
                [{ category: 'keep' }, { tenantId: ['family', 'group'] }],
                [{ category: 'keep' }, { tenantId: null }],
              ],
            });
            expect(() => read({ tenantId: 'sibling' })).toThrow('out-of-scope');
            registerTenantScopedClass('UnlistedHierarchyModel', {
              mode: 'required',
            });
            try {
              expect(() =>
                interceptor.beforeList?.(
                  'UnlistedHierarchyModel',
                  {},
                  createInterceptorContext('UnlistedHierarchyModel', 'list'),
                ),
              ).toThrow('does not allow');
            } finally {
              unregisterTenantScopedClass('UnlistedHierarchyModel');
            }
            await expect(
              withSystemContext(async () =>
                interceptor.beforeGet?.(name, {}, context),
              ),
            ).rejects.toThrow('actor changed');
            await expect(
              withTenant(
                { tenantId: 'sibling', userId: 'guardian' },
                async () => read(),
              ),
            ).rejects.toThrow('actor changed');
            await expect(
              withTenant({ tenantId: 'family', userId: 'other' }, async () =>
                read(),
              ),
            ).rejects.toThrow('actor changed');
            await expect(withSystemContext(async () => read())).rejects.toThrow(
              'actor changed',
            );
            expect(() =>
              interceptor.beforeGet?.(name, { tenantId: 'group' }, context),
            ).toThrow();
            expect(() =>
              interceptor.beforeQuery?.(
                name,
                { sql: 'SELECT 1', params: [], allowRawOnTenantScoped: true },
                context,
              ),
            ).toThrow('does not permit query');
            expect(() =>
              interceptor.beforeSave?.(
                { tenantId: 'family' } as never,
                context,
              ),
            ).toThrow('does not permit save');
            expect(() =>
              interceptor.beforeDelete?.(
                { tenantId: 'family' } as never,
                context,
              ),
            ).toThrow('does not permit delete');
            await expect(
              runTenantHierarchyReadScope(
                {
                  actorTenantId: 'family',
                  actorUserId: 'guardian',
                  collections: [name],
                  includeGlobal: false,
                  tenantIds: ['sibling'],
                },
                async () => undefined,
              ),
            ).rejects.toThrow('nested');
          },
        );
        expect(await read()).toMatchObject({ where: { tenantId: 'family' } });
      },
    );
  });
});
