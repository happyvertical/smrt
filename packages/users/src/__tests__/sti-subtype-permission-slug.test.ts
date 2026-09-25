/**
 * #3125: an STI subtype of `Tenant` decorated before its app manifest loads —
 * a consumer's production (bundled) build — must derive the operation
 * permission slug the catalog lists. It derived `<pluralized class>.update`
 * (`networks.update`), which no catalog entry names, so operation guards
 * denied every caller with `unknown_permission`.
 */
import {
  ObjectRegistry,
  type SmartObjectManifest,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { Tenant } from '../models/Tenant.js';
import {
  deriveOperationPermissionSlug,
  PermissionCatalogService,
} from '../services/index.js';

const APP = '@fixture/sti-permission-app';

// Applied as a call, the shape of a bundled server chunk
// (`__decorate([smrt(...)], Network)`), with no manifest entry for the class.
const StiPermissionNetwork = smrt({ tableStrategy: 'sti', packageName: APP })(
  class StiPermissionNetwork extends Tenant {},
);

// Implicit STI: the strategy is inherited from Tenant.
const StiPermissionPublication = smrt({ packageName: APP })(
  class StiPermissionPublication extends Tenant {},
);

// A plain class with no manifest entry keeps its historical catalog slug.
smrt({ packageName: APP })(class StiPermissionAuditNote extends SmrtObject {});

const catalogSlugs = () =>
  PermissionCatalogService.create()
    .getCatalog()
    .permissions.map((permission) => permission.slug);

function registerAppManifest(): void {
  const entry = (className: string) => ({
    name: className.toLowerCase(),
    className,
    qualifiedName: `${APP}:${className}`,
    packageName: APP,
    filePath: `src/models/${className}.ts`,
    extends: 'Tenant',
    collection: 'tenants',
    fields: {},
    methods: {},
    decoratorConfig: { tableStrategy: 'sti', tableName: 'tenants' },
  });
  ObjectRegistry.registerPackageManifest({
    version: '1',
    timestamp: 0,
    packageName: APP,
    objects: {
      [`${APP}:StiPermissionNetwork`]: entry('StiPermissionNetwork'),
      [`${APP}:StiPermissionPublication`]: entry('StiPermissionPublication'),
    },
  } as unknown as SmartObjectManifest);
}

describe('STI subtype operation permission slugs (#3125)', () => {
  it("derives the STI base's slug, which the catalog lists, before and after the app manifest registers", () => {
    for (const phase of ['before manifest', 'after manifest'] as const) {
      if (phase === 'after manifest') registerAppManifest();

      expect(
        ObjectRegistry.getClassByConstructor(StiPermissionNetwork)?.config
          .tableName,
        phase,
      ).toBe('tenants');
      expect(deriveOperationPermissionSlug(Tenant, 'update'), phase).toBe(
        'tenants.update',
      );
      expect(
        deriveOperationPermissionSlug(StiPermissionNetwork, 'update'),
        phase,
      ).toBe('tenants.update');
      expect(
        deriveOperationPermissionSlug(StiPermissionPublication, 'delete'),
        phase,
      ).toBe('tenants.delete');
      expect(
        deriveOperationPermissionSlug(new StiPermissionNetwork(), 'get'),
        phase,
      ).toBe('tenants.read');

      const service = PermissionCatalogService.create();
      expect(service.hasPermissionSlug('tenants.update'), phase).toBe(true);
      expect(service.hasPermissionSlug('tenants.delete'), phase).toBe(true);
      const slugs = catalogSlugs();
      expect(
        slugs.filter((slug) => /^sti_?permission/.test(slug)),
        phase,
      ).toEqual([
        'sti_permission_audit_notes.create',
        'sti_permission_audit_notes.delete',
        'sti_permission_audit_notes.read',
        'sti_permission_audit_notes.update',
      ]);
    }
  });
});
