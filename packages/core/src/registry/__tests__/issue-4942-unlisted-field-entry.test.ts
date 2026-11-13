/**
 * #4942 with #4932 at run time: a manifest built before this release has no
 * `_meta.__statedOptions` on its fields. Loading it must not refuse a subclass
 * for a `required: false` the older scanner inferred.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';

const PKG = '@test4942/old';
const entry = (
  className: string,
  fields: Record<string, unknown>,
  extendsName?: string,
  config: Record<string, unknown> = {},
) =>
  ({
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${PKG}/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: config,
    packageName: PKG,
    ...(extendsName ? { extends: extendsName } : {}),
  }) as never;

describe.each([
  ['own-table', {}],
  ['shared-table', { tableStrategy: 'sti', tableName: 'old_docs_4942' }],
] as const)('a manifest with no stated-options list (%s)', (_label, config) => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('does not refuse a subclass for an inferred required:false', async () => {
    ObjectRegistry.registerFromManifest(
      `${PKG}:OldBase`,
      entry(
        'OldBase',
        {
          code: {
            type: 'text',
            required: true,
            _meta: {
              requiredFor: 'identity',
              __statedOptions: ['required', 'requiredFor'],
            },
          },
        },
        undefined,
        config,
      ),
      PKG,
    );
    ObjectRegistry.registerFromManifest(
      `${PKG}:OldChild`,
      // Built before the list existed: required:false is what the scanner inferred.
      entry(
        'OldChild',
        { code: { type: 'text', required: false } },
        'OldBase',
        {},
      ),
      PKG,
    );
    const fields = await ObjectRegistry.getAllFields(`${PKG}:OldChild`);
    const code = fields.get('code');
    // A field loaded from a manifest keeps the flag under `_meta`.
    expect(code?.required ?? code?._meta?.required).toBe(true);
    expect(fields.get('code')?._meta?.requiredFor).toBe('identity');
  });

  it('still refuses a subclass whose entry states required:false', async () => {
    ObjectRegistry.registerFromManifest(
      `${PKG}:StatedBase`,
      entry(
        'StatedBase',
        {
          code: {
            type: 'text',
            required: true,
            _meta: {
              requiredFor: 'identity',
              __statedOptions: ['required', 'requiredFor'],
            },
          },
        },
        undefined,
        config,
      ),
      PKG,
    );
    ObjectRegistry.registerFromManifest(
      `${PKG}:StatedChild`,
      entry(
        'StatedChild',
        {
          code: {
            type: 'text',
            required: false,
            _meta: { __statedOptions: ['required'] },
          },
        },
        'StatedBase',
        {},
      ),
      PKG,
    );
    await expect(
      ObjectRegistry.getAllFields(`${PKG}:StatedChild`),
    ).rejects.toThrow(/StatedChild\.code cannot be made optional.*identity/);
  });
});

describe('decorator-registered fields state what the author wrote', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('records the decorator options as the stated list, so an unwritten required inherits', async () => {
    @smrt({ tableName: 'dec4942_parents' })
    class DecParent4942 extends SmrtObject {
      @field({ required: true, requiredFor: 'identity' }) code = '';
    }
    @smrt({ tableName: 'dec4942_children' })
    class DecChild4942 extends DecParent4942 {
      @field({ description: 'Our code' }) override code = '';
    }
    const qn =
      ObjectRegistry.getClassByConstructor(DecChild4942)!.qualifiedName!;
    const code = (await ObjectRegistry.getAllFields(qn)).get('code');
    const own =
      ObjectRegistry.getClassByConstructor(DecChild4942)?.fields.get('code');
    expect(own?._meta?.__statedOptions).toEqual(['description']);
    expect(code?.required ?? code?._meta?.required).toBe(true);
    expect(code?._meta?.requiredFor).toBe('identity');
  });
});
