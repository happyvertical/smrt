import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import type { SmartObjectManifest } from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { manifestEntry } from './helpers/consumer-workspace.js';

function manifest(
  packageName = '@fixture/operations',
  collection = 'billing.records',
) {
  return {
    version: '1',
    timestamp: 0,
    packageName,
    objects: {
      RecordOperation: {
        ...manifestEntry({
          className: 'RecordOperation',
          packageName,
          filePath: '/fixture/RecordOperation.ts',
          tableName: 'record_operations',
          fields: {},
        }),
        // Published older manifests carry a derived top-level value. The explicit
        // declaration still has authority during generated registration.
        collection: 'recordoperations',
        decoratorConfig: {
          collection,
          tableName: 'record_operations',
          api: false,
          cli: false,
          mcp: false,
        },
      },
    },
  } satisfies SmartObjectManifest;
}

describe('#3736 generated registration collection parity', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it.each([
    'initial',
    'stub-first',
    'registered-first',
  ] as const)('honors manifest declaration for %s real constructor registration', (order) => {
    class RecordOperation extends SmrtObject {}
    const input = manifest();
    if (order === 'stub-first') ObjectRegistry.registerPackageManifest(input);
    if (order === 'registered-first')
      ObjectRegistry.register(RecordOperation, {
        packageName: input.packageName,
      });
    // Exact generated consumer call shape: configuration lives in _manifest.
    ObjectRegistry.register(RecordOperation, {
      name: 'RecordOperation',
      packageName: input.packageName,
      _manifest: input,
      _manifestKey: 'RecordOperation',
    });
    const registration = ObjectRegistry.getClassByConstructor(RecordOperation);
    expect(registration?.constructor).toBe(RecordOperation);
    expect(registration?.qualifiedName).toBe(
      '@fixture/operations:RecordOperation',
    );
    expect(registration?.config.collection).toBe('billing.records');
    expect(registration?.collection).toBe('billing.records');
  });

  it('preserves explicit call overrides and separates the same class name in another package', () => {
    class RecordOperation extends SmrtObject {}
    const OtherOperation = class RecordOperation extends SmrtObject {};
    ObjectRegistry.register(RecordOperation, {
      packageName: '@fixture/operations',
      collection: 'billing.override',
      _manifest: manifest(),
      _manifestKey: 'RecordOperation',
    });
    ObjectRegistry.register(OtherOperation, {
      packageName: '@fixture/other',
      _manifest: manifest('@fixture/other', 'support.records'),
      _manifestKey: 'RecordOperation',
    });
    expect(
      ObjectRegistry.getClassByConstructor(RecordOperation)?.collection,
    ).toBe('billing.override');
    expect(
      ObjectRegistry.getClassByConstructor(OtherOperation)?.collection,
    ).toBe('support.records');
    expect(
      ObjectRegistry.getClassByConstructor(OtherOperation)?.qualifiedName,
    ).toBe('@fixture/other:RecordOperation');
  });

  it('retains derived manifest defaults when no explicit namespace is declared', () => {
    class RecordOperation extends SmrtObject {}
    const input = manifest();
    delete (
      input.objects.RecordOperation.decoratorConfig as { collection?: string }
    ).collection;
    ObjectRegistry.register(RecordOperation, {
      packageName: input.packageName,
      _manifest: input,
      _manifestKey: 'RecordOperation',
    });
    expect(
      ObjectRegistry.getClassByConstructor(RecordOperation)?.collection,
    ).toBe('recordoperations');
  });
});
