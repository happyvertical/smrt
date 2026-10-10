import { describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';

describe('#3736 explicit collection manifest parity', () => {
  it('preserves standalone declared namespaces through parsing and manifest emission', () => {
    const parsed = parseSource(
      `
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      @smrt({ collection: 'billing.records', tableName: 'billing_operation_records', api: false, cli: false, mcp: false })
      export class RecordOperation extends SmrtObject {}
      @smrt({ collection: 'support.messages', api: false })
      export class MessageOperation extends SmrtObject {}
      @smrt({})
      export class City extends SmrtObject {}
    `,
      '/fixture/operations.ts',
    );
    expect(parsed.errors).toEqual([]);
    const resolver = new InheritanceResolver();
    resolver.addClasses(parsed.classes);
    const adapter = new ManifestAdapter();
    const objects = resolver.resolveAll().map((entry) =>
      adapter.toSmartObjectDefinition(entry, {
        packageName: '@fixture/operations',
      }),
    );
    const record = objects.find(
      (entry) => entry.className === 'RecordOperation',
    );
    expect(record).toMatchObject({
      collection: 'billing.records',
      qualifiedName: '@fixture/operations:RecordOperation',
      decoratorConfig: {
        collection: 'billing.records',
        tableName: 'billing_operation_records',
        api: false,
        cli: false,
        mcp: false,
      },
    });
    expect(
      objects.find((entry) => entry.className === 'MessageOperation')
        ?.collection,
    ).toBe('support.messages');
    expect(
      objects.find((entry) => entry.className === 'City')?.collection,
    ).toBe('cities');
  });
});
