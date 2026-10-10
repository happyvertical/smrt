import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { checkOperationPermission } from '../services/OperationPermissionService.js';
import { deriveOperationPermissionSlug } from '../services/PermissionCatalogService.js';

describe('#3736 generated collection permission identity', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it('authorizes the declared namespace and never substitutes a synthetic collection grant', async () => {
    class InvoiceOperation extends SmrtObject {}
    const manifest = {
      version: '1',
      timestamp: 0,
      packageName: '@fixture/billing',
      objects: {
        InvoiceOperation: {
          name: 'invoiceoperation',
          className: 'InvoiceOperation',
          collection: 'invoiceoperations',
          packageName: '@fixture/billing',
          filePath: '/fixture/InvoiceOperation.ts',
          extends: 'SmrtObject',
          fields: {},
          methods: {},
          decoratorConfig: {
            collection: 'billing.records',
            tableName: 'invoice_operations',
            api: false as const,
            cli: false as const,
            mcp: false as const,
          },
        },
      },
    };
    ObjectRegistry.register(InvoiceOperation, {
      name: 'InvoiceOperation',
      packageName: manifest.packageName,
      _manifest: manifest,
      _manifestKey: 'InvoiceOperation',
    });
    const registered = ObjectRegistry.getClassByConstructor(InvoiceOperation)!;
    expect(deriveOperationPermissionSlug(InvoiceOperation, 'write')).toBe(
      'billing.records.write',
    );
    // Same string boundary ingestion/agents pass to assertOperation(). Only the
    // real namespace exists in this trusted catalog; no synthetic grant is added.
    const options = {
      collection: registered.collection!,
      action: 'write',
      userId: 'reviewer',
      tenantId: 'tenant-a',
      allowSystemContextBypass: false,
      allowSuperAdminBypass: false,
      catalog: {
        customPermissions: [],
        manifestPermissions: [],
        runtimePermissions: [],
        permissions: [{ slug: 'billing.records.write' }],
      },
    };
    expect(
      await checkOperationPermission({
        ...options,
        permissionSet: ['billing.records.write'],
      }),
    ).toMatchObject({
      allowed: true,
      permission: 'billing.records.write',
      reason: 'permission_granted',
    });
    expect(
      await checkOperationPermission({
        ...options,
        permissionSet: ['invoiceoperations.write'],
      }),
    ).toMatchObject({
      allowed: false,
      permission: 'billing.records.write',
      reason: 'permission_denied',
    });
    expect(
      await checkOperationPermission({ ...options, permissionSet: [] }),
    ).toMatchObject({ allowed: false, reason: 'permission_denied' });
    expect(
      await checkOperationPermission({
        ...options,
        userId: null,
        permissionSet: ['billing.records.write'],
      }),
    ).toMatchObject({ allowed: false, reason: 'missing_principal' });
  });
});
