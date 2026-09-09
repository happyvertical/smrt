/**
 * Caller-path regressions for #2763.
 *
 * The required `TenantIdentityRelated` and optional `TenantIdentityRelated`
 * below deliberately share their simple name while belonging to different
 * packages. The optional registration is evaluated last, reproducing the
 * collision that previously made real core callers consult the wrong tenancy
 * policy. These tests use the public collection/object APIs and the real
 * tenancy interceptor; they do not construct interceptor contexts themselves.
 */

import {
  field,
  foreignKey,
  GlobalInterceptors,
  ObjectRegistry,
  oneToMany,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextError, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-2763-4aaa-8aaa-aaaaaaaaaaa1';

describe('qualified tenant identity through real caller paths (#2763)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let parents: SmrtCollection<any>;
  let openParents: SmrtCollection<any>;
  let related: SmrtCollection<any>;
  let RequiredRelated: typeof SmrtObject;
  let OptionalRelated: typeof SmrtObject;
  let parentId = '';
  let openParentId = '';
  let relatedId = '';

  beforeAll(async () => {
    // Deliberately declare these after the Vitest manifest scan. They are
    // runtime registrations, matching the consumer path that originally
    // collided, rather than a generated local-manifest fixture.
    @smrt({
      packageName: '@fixture/tenant-identity-parent',
      tableName: 'tenant_identity_parents_2763',
    })
    @TenantScoped({ mode: 'required' })
    class TenantIdentityParent extends SmrtObject {
      @field({ type: 'text' })
      title = '';

      @tenantId({ nullable: true })
      tenantId: string | null = null;

      @oneToMany('@fixture/tenant-identity-required:TenantIdentityRelated', {
        foreignKey: 'parentId',
      })
      related: SmrtObject[] = [];
    }

    let OpenParent: typeof SmrtObject;
    {
      @smrt({
        packageName: '@fixture/tenant-identity-required',
        tableName: 'tenant_identity_open_parents_2763',
      })
      @TenantScoped({ mode: 'optional' })
      class TenantIdentityOpenParent extends SmrtObject {
        @field({ type: 'text' })
        title = '';

        @tenantId({ nullable: true })
        tenantId: string | null = null;

        @oneToMany('@fixture/tenant-identity-required:TenantIdentityRelated', {
          foreignKey: 'openParentId',
        })
        related: SmrtObject[] = [];
      }
      OpenParent = TenantIdentityOpenParent;
    }

    @smrt({
      packageName: '@fixture/tenant-identity-required',
      tableName: 'tenant_identity_required_related_2763',
    })
    @TenantScoped({ mode: 'required' })
    class TenantIdentityRelated extends SmrtObject {
      @foreignKey(TenantIdentityParent)
      parentId = '';

      @foreignKey(OpenParent)
      openParentId = '';

      @field({ type: 'integer' })
      sequence = 0;

      @field({ type: 'text' })
      title = '';

      @tenantId({ nullable: true })
      tenantId: string | null = null;
    }
    RequiredRelated = TenantIdentityRelated;

    // This cross-package peer is deliberately optional and evaluated after
    // the required class. It has no physical relationship: @foreignKey()
    // relationships stay inside the required fixture package.
    {
      @smrt({
        packageName: '@fixture/tenant-identity-optional',
        tableName: 'tenant_identity_optional_parents_2763',
      })
      @TenantScoped({ mode: 'optional' })
      class TenantIdentityParent extends SmrtObject {
        @field({ type: 'text' })
        title = '';

        @tenantId({ nullable: true })
        tenantId: string | null = null;
      }
    }

    {
      // Intentionally evaluated last: the simple-name tenancy registry now
      // contains optional policy, while core's constructor-bound qualified
      // registration must still select required policy for RequiredRelated.
      @smrt({
        packageName: '@fixture/tenant-identity-optional',
        tableName: 'tenant_identity_optional_related_2763',
      })
      @TenantScoped({ mode: 'optional' })
      class TenantIdentityRelated extends SmrtObject {
        @field({ type: 'text' })
        title = '';

        @tenantId({ nullable: true })
        tenantId: string | null = null;
      }
      OptionalRelated = TenantIdentityRelated;
    }

    class TenantIdentityParentCollection extends SmrtCollection<TenantIdentityParent> {
      static readonly _itemClass = TenantIdentityParent;
    }
    class TenantIdentityRelatedCollection extends SmrtCollection<TenantIdentityRelated> {
      static readonly _itemClass = TenantIdentityRelated;
    }
    class TenantIdentityOpenParentCollection extends SmrtCollection<any> {
      static readonly _itemClass = OpenParent;
    }
    ObjectRegistry.registerCollection(
      '@fixture/tenant-identity-parent:TenantIdentityParent',
      TenantIdentityParentCollection,
    );
    ObjectRegistry.registerCollection(
      '@fixture/tenant-identity-required:TenantIdentityOpenParent',
      TenantIdentityOpenParentCollection,
    );
    ObjectRegistry.registerCollection(
      '@fixture/tenant-identity-required:TenantIdentityRelated',
      TenantIdentityRelatedCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        '@fixture/tenant-identity-parent:TenantIdentityParent',
        '@fixture/tenant-identity-required:TenantIdentityOpenParent',
        '@fixture/tenant-identity-required:TenantIdentityRelated',
        '@fixture/tenant-identity-optional:TenantIdentityRelated',
      ],
    });
    parents = await TenantIdentityParentCollection.create({ db });
    openParents = await TenantIdentityOpenParentCollection.create({
      db,
    });
    related = await TenantIdentityRelatedCollection.create({ db });
    enableTenancy();

    await withTenant({ tenantId: TENANT_A }, async () => {
      const parent = await parents.create({ title: 'parent' });
      parentId = parent.id;
      const openParent = await openParents.create({
        title: 'open parent',
      });
      openParentId = openParent.id;
      const child = await related.create({
        parentId,
        openParentId,
        sequence: 1,
        title: 'related',
      });
      relatedId = child.id;
    });
  });

  afterAll(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('rejects missing context for both parent and related latest-related caller paths', async () => {
    await expect(
      parents.listWithLatestRelated({
        latestRelated: { relation: 'related', orderBy: 'sequence DESC' },
      }),
    ).rejects.toThrow(TenantContextError);

    // The distinct optional parent reaches the related `beforeList` hook. Its
    // required same-name peer must reject even though an optional peer was
    // registered later under the shared simple name.
    await expect(
      openParents.listWithLatestRelated({
        latestRelated: { relation: 'related', orderBy: 'sequence DESC' },
      }),
    ).rejects.toThrow(TenantContextError);

    await expect(
      withTenant({ tenantId: TENANT_A }, () =>
        parents.listWithLatestRelated({
          latestRelated: {
            relation: 'related',
            orderBy: 'sequence DESC',
            select: ['id', 'parentId'],
          },
        }),
      ),
    ).resolves.toMatchObject([
      {
        parent: { id: parentId },
        latestRelated: { id: relatedId, parentId },
      },
    ]);
    await expect(
      withTenant({ tenantId: TENANT_A }, () =>
        openParents.listWithLatestRelated({
          latestRelated: {
            relation: 'related',
            orderBy: 'sequence DESC',
            select: ['id', 'openParentId'],
          },
        }),
      ),
    ).resolves.toMatchObject([
      {
        parent: { id: openParentId },
        latestRelated: { id: relatedId, openParentId },
      },
    ]);
  });

  it('keeps the required same-name class closed for hydration and mutations while its optional peer remains permissive', async () => {
    const hydration = new RequiredRelated({ db, id: relatedId });
    await expect(hydration.initialize()).rejects.toThrow(TenantContextError);

    const unsaved = new RequiredRelated({
      db,
      parentId,
      title: 'must not save without tenant',
    });
    await expect(unsaved.save()).rejects.toThrow(TenantContextError);

    const loadedForClaim = await withTenant({ tenantId: TENANT_A }, () =>
      related.get(relatedId),
    );
    if (!loadedForClaim)
      throw new Error('Expected authorized tenant fixture row');
    await expect(
      loadedForClaim.claimRevision(loadedForClaim.updated_at as Date),
    ).rejects.toThrow(TenantContextError);

    const loadedForDelete = await withTenant({ tenantId: TENANT_A }, () =>
      related.get(relatedId),
    );
    if (!loadedForDelete)
      throw new Error('Expected authorized tenant fixture row');
    await expect(loadedForDelete.delete()).rejects.toThrow(TenantContextError);

    const optional = new OptionalRelated({
      db,
      title: 'optional peer may save without tenant',
    });
    await optional.initialize();
    await expect(optional.save()).resolves.toBe(optional);
  });

  it('preserves the simple-name custom interceptor contract on real callers', async () => {
    const calls: Array<{ className: string; contextClassName: string }> = [];
    const interceptor = {
      name: 'issue-2763-simple-name-compatibility',
      beforeList(
        className: string,
        _options: unknown,
        context: { className: string },
      ) {
        calls.push({ className, contextClassName: context.className });
      },
    };
    GlobalInterceptors.register(interceptor);
    try {
      await withTenant({ tenantId: TENANT_A }, () => related.list({}));
    } finally {
      GlobalInterceptors.unregister(interceptor);
    }
    expect(calls).toContainEqual({
      className: 'TenantIdentityRelated',
      contextClassName: 'TenantIdentityRelated',
    });
  });
});
