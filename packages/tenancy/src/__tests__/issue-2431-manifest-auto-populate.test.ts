/**
 * Regression for boolean tenantScoped manifests requiring tenant_id before the
 * tenancy beforeSave hook can auto-populate it.
 */

import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { ManifestGenerator } from '@happyvertical/smrt-core/scanner';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { withTenant } from '../context.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

afterEach(() => {
  disableTenancy();
  ObjectRegistry.clear();
});

describe('boolean tenantScoped manifest auto-population (#2431)', () => {
  it('stamps a manifest-required tenantId before saving inside withTenant()', async () => {
    const manifest = new ManifestGenerator().generateManifest([
      {
        filePath: '/fixtures/manifest-tenant-doc-2431.ts',
        objects: [
          {
            name: 'manifestTenantDoc2431',
            className: 'ManifestTenantDoc2431',
            collection: 'manifest_tenant_docs_2431',
            filePath: '/fixtures/manifest-tenant-doc-2431.ts',
            fields: { title: { type: 'text', required: true } },
            methods: {},
            decoratorConfig: { tenantScoped: true },
            exportName: 'ManifestTenantDoc2431',
            collectionExportName: 'ManifestTenantDoc2431Collection',
          },
        ],
        imports: [],
        exports: [],
      },
    ]);
    const definition = manifest.objects.manifestTenantDoc2431;

    expect(definition.fields.tenantId?.required).toBe(true);
    expect(definition.schema?.columns.tenant_id.notNull).toBe(true);
    expect(
      definition.validationRules?.some(
        (rule) => rule.field === 'tenantId' && rule.rule === 'required',
      ),
    ).toBe(false);

    // This is the runtime production path: a manifest stub is registered first
    // and is then promoted when the application loads the real decorator class.
    ObjectRegistry.registerFromManifest('ManifestTenantDoc2431', definition);

    @smrt({ tenantScoped: true })
    class ManifestTenantDoc2431 extends SmrtObject {
      @field({ type: 'text' })
      title = '';
    }

    class ManifestTenantDoc2431Collection extends SmrtCollection<ManifestTenantDoc2431> {
      static readonly _itemClass = ManifestTenantDoc2431;
    }

    ObjectRegistry.registerCollection(
      'ManifestTenantDoc2431',
      ManifestTenantDoc2431Collection,
    );

    const registered = ObjectRegistry.getClass('ManifestTenantDoc2431');
    expect(registered?.validationRules).toEqual(definition.validationRules);
    expect(registered?.validators).toBeUndefined();

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ManifestTenantDoc2431'],
    });
    try {
      enableTenancy();
      const collection = await ManifestTenantDoc2431Collection.create({ db });
      const doc = await withTenant({ tenantId: 'tenant-2431' }, async () => {
        const created = await collection.create({ title: 'Scoped document' });
        await created.save();
        return created;
      });

      expect(doc.tenantId).toBe('tenant-2431');
      await withTenant({ tenantId: 'tenant-2431' }, async () => {
        const persisted = await collection.get(doc.id as string);
        expect(persisted?.tenantId).toBe('tenant-2431');
      });
    } finally {
      await db.close();
    }
  });
});
