/**
 * #3599: presentation metadata in the manifest — `@field({ ui: { widget } })`,
 * the own-field display label, and `ModuleUISlot.selects` selector bindings —
 * with the build-time validation that stops a declaration no host could honor.
 */
import { describe, expect, it } from 'vitest';
import {
  buildToolDescriptors,
  describeAction,
} from '../../generators/tool-schema.js';
import { buildDomainKnowledgeManifest } from '../../knowledge.js';
import {
  DEFAULT_DISPLAY_LABEL_FIELDS,
  FIELD_UI_WIDGETS,
  findSelectorFor,
  resolveDisplayLabelField,
} from '../../ui-metadata.js';
import { ManifestGenerator } from '../manifest-generator.js';
import type {
  FieldDefinition,
  ManifestUISelector,
  ScanResult,
} from '../types.js';

const PKG = '@example/sales';

function scan(
  fields: Record<string, FieldDefinition>,
  decoratorConfig: Record<string, unknown> = {},
): ScanResult[] {
  return [
    {
      filePath: 'src/order.ts',
      objects: [
        {
          name: 'order',
          className: 'Order',
          collection: 'orders',
          filePath: 'src/order.ts',
          fields,
          methods: {},
          decoratorConfig: { tableName: 'orders', ...decoratorConfig },
          exportName: 'Order',
          collectionExportName: 'OrderCollection',
        },
      ],
      errors: [],
    },
  ];
}

function generate(
  fields: Record<string, FieldDefinition>,
  decoratorConfig: Record<string, unknown> = {},
) {
  return new ManifestGenerator().generateManifest(
    scan(fields, decoratorConfig),
    { packageName: PKG },
  );
}

const text = (extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  type: 'text',
  required: false,
  ...extra,
});

describe('@field ui.widget (#3599)', () => {
  it('carries a valid widget in the manifest under _meta.ui', () => {
    const manifest = generate({
      notes: text({ _meta: { ui: { widget: 'textarea', group: 'extra' } } }),
      total: {
        type: 'integer',
        required: false,
        _meta: { ui: { widget: 'currency' } },
      },
    });
    const fields = manifest.objects[`${PKG}:Order`].fields;
    expect(fields.notes._meta?.ui).toEqual({
      widget: 'textarea',
      group: 'extra',
    });
    expect(fields.total._meta?.ui).toEqual({ widget: 'currency' });
  });

  it.each(
    FIELD_UI_WIDGETS.filter((w) => w !== 'currency'),
  )('accepts %s on a text field and rejects it on an integer field', (widget) => {
    expect(() =>
      generate({ f: text({ _meta: { ui: { widget } } }) }),
    ).not.toThrow();
    expect(() =>
      generate({
        f: { type: 'integer', required: false, _meta: { ui: { widget } } },
      }),
    ).toThrow(
      new RegExp(`Order\\.f: ui\\.widget "${widget}" needs a text field`),
    );
  });

  it('rejects currency on a text field and accepts decimal', () => {
    expect(() =>
      generate({ f: text({ _meta: { ui: { widget: 'currency' } } }) }),
    ).toThrow(/needs a integer or decimal field/);
    expect(() =>
      generate({
        f: {
          type: 'decimal',
          required: false,
          _meta: { ui: { widget: 'currency' } },
        },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown widget and names the valid ones', () => {
    expect(() =>
      generate({ f: text({ _meta: { ui: { widget: 'slider' as never } } }) }),
    ).toThrow(/"slider" is not one of textarea, currency, email, url, phone/);
  });

  it('rejects a widget on a relationship field', () => {
    expect(() =>
      generate({
        f: {
          type: 'foreignKey',
          required: false,
          related: 'Customer',
          _meta: { ui: { widget: 'textarea' } },
        },
      }),
    ).toThrow(/needs a text field, but this field is foreignKey/);
  });
});

describe('own-field display label (#3599)', () => {
  it('stamps the declared label field', () => {
    const manifest = generate(
      { orderNumber: text(), name: text() },
      { display: { label: 'orderNumber' } },
    );
    expect(manifest.objects[`${PKG}:Order`].displayLabelField).toBe(
      'orderNumber',
    );
    expect(manifest.objects[`${PKG}:Order`].decoratorConfig.display).toEqual({
      label: 'orderNumber',
    });
  });

  it('defaults to the first of name, title, label, code', () => {
    expect([...DEFAULT_DISPLAY_LABEL_FIELDS]).toEqual([
      'name',
      'title',
      'label',
      'code',
    ]);
    expect(
      generate({ code: text(), title: text() }).objects[`${PKG}:Order`]
        .displayLabelField,
    ).toBe('title');
    expect(
      generate({ code: text() }).objects[`${PKG}:Order`].displayLabelField,
    ).toBe('code');
  });

  it('skips a sensitive or relationship default candidate', () => {
    const manifest = generate({
      name: text({ sensitive: true }),
      title: { type: 'foreignKey', required: false, related: 'X' },
      label: text(),
    });
    expect(manifest.objects[`${PKG}:Order`].displayLabelField).toBe('label');
  });

  it('is absent when no field qualifies', () => {
    expect(
      generate({ reference: text() }).objects[`${PKG}:Order`].displayLabelField,
    ).toBeUndefined();
  });

  it('fails the build for a missing, sensitive, transient or relationship label', () => {
    expect(() =>
      generate({ name: text() }, { display: { label: 'nope' } }),
    ).toThrow(/display\.label "nope" cannot label a record: it is not a field/);
    expect(() =>
      generate(
        { ssn: text({ sensitive: true }) },
        { display: { label: 'ssn' } },
      ),
    ).toThrow(/it is a sensitive field/);
    expect(() =>
      generate(
        { ssn: text({ _meta: { sensitive: true } }) },
        { display: { label: 'ssn' } },
      ),
    ).toThrow(/it is a sensitive field/);
    expect(() =>
      generate(
        { tmp: text({ transient: true }) },
        { display: { label: 'tmp' } },
      ),
    ).toThrow(/transient/);
    expect(() =>
      generate(
        { customer: { type: 'foreignKey', required: false, related: 'C' } },
        { display: { label: 'customer' } },
      ),
    ).toThrow(/foreignKey field is not the record's own value/);
  });

  it('fails the build for a path into another package or a non-string label', () => {
    expect(() =>
      generate({ name: text() }, { display: { label: 'customer.name' } }),
    ).toThrow(/not a field of this model/);
    expect(() => generate({ name: text() }, { display: { label: 3 } })).toThrow(
      /must be the name of an own field/,
    );
    expect(() => generate({ name: text() }, { display: 'name' })).toThrow(
      /display must be an object/,
    );
  });

  it('is emitted into the knowledge artifact', () => {
    const manifest = generate(
      { orderNumber: text(), name: text() },
      { display: { label: 'orderNumber' } },
    );
    const knowledge = buildDomainKnowledgeManifest({
      manifest,
      rootDir: process.cwd(),
    });
    expect(
      knowledge.objects.find((o) => o.name === 'Order')?.displayLabelField,
    ).toBe('orderNumber');
  });

  it('names the label field in generated tool descriptions, only when there is one', () => {
    expect(describeAction('list', 'Order', 'orderNumber')).toBe(
      'List Order objects with optional filtering. Records are identified by their `orderNumber` field.',
    );
    for (const verb of ['get', 'update', 'delete']) {
      expect(describeAction(verb, 'Order', 'name')).toContain('`name`');
    }
    expect(describeAction('create', 'Order', 'name')).toBe(
      'Create a new Order',
    );
    expect(describeAction('list', 'Order')).toBe(
      'List Order objects with optional filtering',
    );
    const descriptors = buildToolDescriptors({
      className: 'Order',
      fields: [],
      actions: ['list', 'get'],
      displayLabelField: 'orderNumber',
    });
    expect(descriptors.map((d) => d.description)).toEqual([
      expect.stringContaining('`orderNumber`'),
      expect.stringContaining('`orderNumber`'),
    ]);
  });

  it('resolves against runtime field maps', () => {
    expect(resolveDisplayLabelField({ title: { type: 'text' } })).toBe('title');
    expect(resolveDisplayLabelField({ name: { type: 'text' } }, 'name')).toBe(
      'name',
    );
    expect(
      resolveDisplayLabelField({ name: { type: 'text' } }, 'gone'),
    ).toBeUndefined();
  });
});

describe('selector slots (#3599)', () => {
  const selector: ManifestUISelector = {
    slotId: 'customer-select',
    selects: '@example/sales:Customer',
    label: 'Customer',
  };

  it('finds the selector for a model across manifests, or none', () => {
    const manifest = { uiSelectors: { 'customer-select': selector } };
    expect(findSelectorFor(manifest, '@example/sales:Customer')).toBe(selector);
    expect(findSelectorFor([{}, manifest], '@example/sales:Customer')).toBe(
      selector,
    );
    expect(findSelectorFor(manifest, '@example/sales:Vendor')).toBeUndefined();
    expect(findSelectorFor({}, '@example/sales:Customer')).toBeUndefined();
  });

  it('rejects a selector for an own-package model that does not exist', () => {
    const gen = new ManifestGenerator();
    const manifest = gen.generateManifest(scan({ name: text() }), {
      packageName: PKG,
    });
    manifest.uiSelectors = {
      'ghost-select': { slotId: 'ghost-select', selects: `${PKG}:Ghost` },
    };
    expect(() => gen.applyUiMetadata(manifest)).toThrow(
      /UI slot "ghost-select" selects @example\/sales:Ghost, which is not an object of @example\/sales/,
    );
  });

  it('accepts own-package and cross-package targets that resolve or cannot be checked here', () => {
    const gen = new ManifestGenerator();
    const manifest = gen.generateManifest(scan({ name: text() }), {
      packageName: PKG,
    });
    manifest.uiSelectors = {
      'order-select': { slotId: 'order-select', selects: `${PKG}:Order` },
      'party-select': {
        slotId: 'party-select',
        selects: '@example/parties:Party',
      },
    };
    expect(() => gen.applyUiMetadata(manifest)).not.toThrow();
  });
});
