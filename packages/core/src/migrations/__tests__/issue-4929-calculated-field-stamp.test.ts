/**
 * #4929 (review r7, probe 4a): a calculated field's expression and input
 * types are part of the schema stamp. The build computes the stamp from the
 * manifest (`manifestColumnsToDefinitions`); migrate records it from the
 * registry (`schema-builder.ts`). The two must agree for a model with a
 * calculated field, or a correctly migrated production app is refused at
 * every start.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { collectMigrateRecordInput } from '../migrate-record.js';

const PKG = '@r7/calculated-stamp';

function def(
  className: string,
  fields: SmartObjectDefinition['fields'],
  decoratorConfig: SmartObjectDefinition['decoratorConfig'] = {},
  parent?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${PKG}/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig,
    packageName: PKG,
    extends: parent ?? 'SmrtObject',
  } as SmartObjectDefinition;
}

function build(objects: SmartObjectDefinition[]): SmartObjectManifest {
  const manifest = new ManifestGenerator().generateManifest(
    [{ filePath: `/${PKG}`, errors: [], objects }],
    { packageName: PKG },
  );
  // The app reads its manifest back from JSON.
  return JSON.parse(JSON.stringify(manifest)) as SmartObjectManifest;
}

describe('the stamp of a calculated field (#4929, r7 probe 4a)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  const register = (manifest: SmartObjectManifest) => {
    for (const [key, object] of Object.entries(manifest.objects)) {
      ObjectRegistry.registerFromManifest(key, object, PKG);
    }
  };

  const orderLine = (factor: number) =>
    build([
      def('OrderLine', {
        qty: { type: 'integer' },
        unitPrice: { type: 'integer' },
        total: {
          type: 'integer',
          generated: {
            op: 'mul',
            left: { col: 'qty' },
            right: { col: 'unitPrice' },
          },
        },
        doubled: {
          type: 'integer',
          generated: {
            op: 'mul',
            left: { col: 'qty' },
            right: { value: factor },
          },
        },
      } as SmartObjectDefinition['fields']),
    ]);

  it('is the same at migrate (registry path) as the build made it (manifest path)', () => {
    const manifest = orderLine(2);
    const columns = Object.values(manifest.objects)[0].schema?.columns ?? {};
    expect(columns.total?.generated).toBeDefined();
    expect(manifest.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    register(manifest);
    expect(collectMigrateRecordInput().fingerprint).toBe(
      manifest.schemaFingerprint,
    );
  });

  it('moves on both paths when only an expression changes', () => {
    const before = orderLine(2);
    const after = orderLine(3);
    expect(after.schemaFingerprint).not.toBe(before.schemaFingerprint);
    register(after);
    expect(collectMigrateRecordInput().fingerprint).toBe(
      after.schemaFingerprint,
    );
  });

  it('is the same on both paths for a calculated field of a shared-table subclass', () => {
    const manifest = build([
      def(
        'SharedLine',
        { qty: { type: 'integer' } },
        { tableStrategy: 'sti', tableName: 'r7_shared_lines' },
      ),
      def(
        'PricedLine',
        {
          unitPrice: { type: 'integer' },
          total: {
            type: 'integer',
            required: true,
            generated: {
              op: 'mul',
              left: { col: 'qty' },
              right: { col: 'unitPrice' },
            },
          },
        } as SmartObjectDefinition['fields'],
        {},
        'SharedLine',
      ),
    ]);
    register(manifest);
    expect(collectMigrateRecordInput().fingerprint).toBe(
      manifest.schemaFingerprint,
    );
  });
});
