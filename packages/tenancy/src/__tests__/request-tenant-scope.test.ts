/**
 * Core's request-time tenant scope with the real tenancy package behind it:
 * ownership fields an STI child inherits, and the public entry that sets a
 * request's tenant context.
 */

import { AsyncResource } from 'node:async_hooks';
import {
  enterRequestTenantContext,
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  scopeTenantReadOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasTenantContext, TenantContextError } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';

const THEIRS = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';

// A shared table registered from its manifest, as a consumer app loads it:
// the ownership field is declared on the base class only, and a manifest
// child's field map holds its own fields. Tenancy is registered at runtime.
const MANIFEST_PKG = '@test/request-scope';
const manifestEntry = (
  className: string,
  fields: Record<string, unknown>,
  decoratorConfig: Record<string, unknown>,
  extendsName: string,
) =>
  ({
    name: className.toLowerCase(),
    className,
    qualifiedName: `${MANIFEST_PKG}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `src/${className}.ts`,
    packageName: MANIFEST_PKG,
    fields,
    methods: {},
    decoratorConfig,
    extends: extendsName,
    exportName: className,
  }) as never;

// Required-mode tenancy: a read without a tenant context is refused.
@smrt({ api: { include: ['list'] } })
@TenantScoped()
class ScopeLedger extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;
}
class ScopeLedgerCollection extends SmrtCollection<ScopeLedger> {
  static readonly _itemClass = ScopeLedger;
}

describe('request-time tenant scope with tenancy enabled', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let ledgers: ScopeLedgerCollection;
  const posterName = `${MANIFEST_PKG}:ScopePoster`;
  const bannerName = `${MANIFEST_PKG}:ScopeBanner`;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('ScopeLedger', ScopeLedgerCollection);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ScopeLedger'],
    });
    ledgers = await ScopeLedgerCollection.create({ db });
    ObjectRegistry.registerFromManifest(
      posterName,
      manifestEntry(
        'ScopePoster',
        {
          title: { type: 'text' },
          organizationId: { type: 'text', nullable: true },
        },
        { tableStrategy: 'sti' },
        'SmrtObject',
      ),
      MANIFEST_PKG,
    );
    ObjectRegistry.registerFromManifest(
      bannerName,
      manifestEntry('ScopeBanner', {}, {}, 'ScopePoster'),
      MANIFEST_PKG,
    );
    enableTenancy();
    registerTenantScopedClass(posterName, {
      mode: 'optional',
      field: 'organizationId',
    });
  });

  afterAll(async () => {
    unregisterTenantScopedClass(posterName);
    disableTenancy();
    await db?.close?.();
  });

  it('an STI child scopes action options under the ownership property it inherits', () => {
    // The child's own field map does not name the ownership field.
    expect(ObjectRegistry.getFields(bannerName).has('organizationId')).toBe(
      false,
    );
    const scoped = scopeTenantReadOptions(bannerName, {
      organizationId: THEIRS,
      organization_id: THEIRS,
      tenantId: THEIRS,
      title: 'kept',
    });
    // The property the base class declares, never the SQL column name.
    expect(scoped).toEqual({ title: 'kept', organizationId: null });
  });

  it('refuses to enter a request tenant context without a tenant', async () => {
    await new AsyncResource('request').runInAsyncScope(async () => {
      for (const tenantIdValue of [null, undefined, '']) {
        expect(() =>
          enterRequestTenantContext({
            tenantId: tenantIdValue as unknown as string,
          }),
        ).toThrow(TypeError);
      }
      // Nothing was entered, so a required-mode read is refused rather than
      // scoped to rows without an owner.
      expect(hasTenantContext()).toBe(false);
      await expect(ledgers.list({})).rejects.toBeInstanceOf(TenantContextError);
    });
  });

  it('enters a request tenant context that names its tenant', async () => {
    await new AsyncResource('request').runInAsyncScope(async () => {
      enterRequestTenantContext({ tenantId: THEIRS });
      expect(hasTenantContext()).toBe(true);
      await expect(ledgers.list({})).resolves.toEqual([]);
    });
  });
});
