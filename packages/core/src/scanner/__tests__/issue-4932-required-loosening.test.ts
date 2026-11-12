/**
 * #4932: an app owns its data shape, and the nearest declaration wins in
 * either direction. The one limit: the build refuses a subclass that makes
 * optional a field smrt requires for its own correctness (a required field
 * that carries `requiredFor`, #4923). The refusal names the class and field.
 */
import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../manifest-generator';
import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../types';

const APP = '@test4932/refusal';

function def(
  className: string,
  fields: Record<string, FieldDefinition>,
  parent: string,
  decoratorConfig: Record<string, unknown> = {},
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${APP}/src/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig,
    packageName: APP,
    extends: parent,
  } as SmartObjectDefinition;
}

function build(objects: SmartObjectDefinition[]): SmartObjectManifest {
  return new ManifestGenerator().generateManifest(
    [{ filePath: `/${APP}/src`, objects, errors: [] }],
    { packageName: APP },
  );
}

const stateRequired: FieldDefinition = {
  type: 'text',
  required: true,
  _meta: { requiredFor: 'workflow-state', __statedOptions: ['requiredFor'] },
};
const tenantRequired: FieldDefinition = {
  type: 'text',
  required: true,
  _meta: {
    sqlType: 'UUID',
    requiredFor: 'tenant-scope',
    __tenancy: { isTenantIdField: true, required: true, nullable: false },
    __statedOptions: ['sqlType', 'requiredFor', '__tenancy'],
  },
};

describe.each([
  ['own-table', {}],
  ['shared-table', { tableStrategy: 'sti' }],
] as const)('requiredFor limit (%s)', (_label, config) => {
  const root = (fields: Record<string, FieldDefinition>) =>
    def('Root4932', fields, 'SmrtObject', config);

  it('refuses a subclass that makes a required-with-reason field optional, naming class and field', () => {
    expect(() =>
      build([
        root({ state: stateRequired }),
        def(
          'Loose4932',
          { state: { type: 'text', required: false } },
          'Root4932',
        ),
      ]),
    ).toThrowError(/Loose4932\.state cannot be made optional.*workflow-state/);
  });

  it('refuses the same loosening through a nullable stated option', () => {
    expect(() =>
      build([
        root({ state: stateRequired }),
        def(
          'Nullable4932',
          {
            state: {
              type: 'text',
              _meta: { nullable: true, __statedOptions: ['nullable'] },
            },
          },
          'Root4932',
        ),
      ]),
    ).toThrowError(/Nullable4932\.state/);
  });

  it('refuses a loosening two classes down, at the class that does it', () => {
    expect(() =>
      build([
        root({ state: stateRequired }),
        def('Middle4932', { note: { type: 'text' } }, 'Root4932'),
        def(
          'Leaf4932',
          { state: { type: 'text', required: false } },
          'Middle4932',
        ),
      ]),
    ).toThrowError(/Leaf4932\.state/);
  });

  it('refuses a required tenant field made optional', () => {
    expect(() =>
      build([
        root({ tenantId: tenantRequired }),
        def(
          'Global4932',
          {
            tenantId: {
              type: 'text',
              required: false,
              _meta: {
                nullable: true,
                __statedOptions: ['required', 'nullable'],
              },
            },
          },
          'Root4932',
        ),
      ]),
    ).toThrowError(
      /Global4932\.tenantId cannot be made optional.*tenant-scope/,
    );
  });

  it('builds when the subclass keeps the field required, restating other options', () => {
    const manifest = build([
      root({ state: stateRequired }),
      def(
        'Same4932',
        {
          state: {
            type: 'text',
            maxLength: 20,
            _meta: { __statedOptions: ['maxLength'] },
          },
        },
        'Root4932',
      ),
    ]);
    const field = manifest.objects[`${APP}:Same4932`].fields.state;
    expect(field.required).toBe(true);
    expect(field._meta?.requiredFor).toBe('workflow-state');
  });

  it('builds when the subclass loosens a field with no reason', () => {
    const manifest = build([
      root({ label: { type: 'text', required: true } }),
      def('Free4932', { label: { type: 'text', required: false } }, 'Root4932'),
    ]);
    expect(manifest.objects[`${APP}:Free4932`].fields.label.required).toBe(
      false,
    );
  });

  it('builds when the subclass tightens a field, and when the parent was already optional', () => {
    const manifest = build([
      root({
        label: { type: 'text' },
        state: { type: 'text', required: false },
      }),
      def(
        'Strict4932',
        {
          label: { type: 'text', required: true },
          state: { type: 'text', required: false },
        },
        'Root4932',
      ),
    ]);
    expect(manifest.objects[`${APP}:Strict4932`].fields.label.required).toBe(
      true,
    );
  });
});
