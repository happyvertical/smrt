import { describe, expect, it } from 'vitest';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  type ApiClientCrudMethod,
  renderApiClientCustomMethodParameters,
  selectApiClientEntries,
} from './api-client-entries.js';

const agreementExecutionCollection = {
  className: 'AgreementExecutionCollection',
  collection: 'agreementExecutions',
  extends: 'SmrtCollection',
  extendsTypeArg: 'AgreementExecution',
  fields: {},
  methods: {},
  decoratorConfig: {},
} as SmartObjectDefinition;

const agreementExecution = {
  className: 'AgreementExecution',
  collection: 'agreementExecutions',
  extends: 'SmrtObject',
  fields: {
    status: { type: 'text', required: true },
    amount: { type: 'decimal', required: true },
  },
  methods: {},
  decoratorConfig: {},
} as SmartObjectDefinition;

const contentsCollection = {
  className: 'Contents',
  collection: 'contents',
  extends: 'SmrtCollection',
  extendsTypeArg: 'Content',
  fields: {},
  methods: {},
  decoratorConfig: {},
} as SmartObjectDefinition;

const content = {
  className: 'Content',
  collection: 'contents',
  extends: 'SmrtObject',
  fields: { title: { type: 'text', required: true } },
  methods: {},
  decoratorConfig: {},
} as SmartObjectDefinition;

function buildManifest(reverse: boolean): SmartObjectManifest {
  const entries: Array<[string, SmartObjectDefinition]> = [
    ['AgreementExecutionCollection', agreementExecutionCollection],
    ['AgreementExecution', agreementExecution],
    ['Contents', contentsCollection],
    ['Content', content],
  ];

  return {
    version: '1.0.0',
    timestamp: 1,
    objects: Object.fromEntries(reverse ? entries.reverse() : entries),
  };
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(
      values.filter((_, candidateIndex) => candidateIndex !== index),
    ).map((rest) => [value, ...rest]),
  );
}

describe('selectApiClientEntries', () => {
  it('renders required typed custom-action parameters as required client options', () => {
    expect(
      renderApiClientCustomMethodParameters(
        {
          name: 'apply',
          scope: 'item',
          pathParamNames: [],
          parameters: [
            {
              name: 'idempotencyKey',
              type: 'string',
              optional: false,
            },
            {
              name: 'expectedVersion',
              type: 'number',
              optional: true,
            },
          ],
        },
        (type) => type,
      ),
    ).toBe(
      'id: string, options: { idempotencyKey: string; expectedVersion?: number }',
    );
  });

  it('selects populated model payloads and stable secondary keys independent of manifest order', () => {
    const collectionFirst = selectApiClientEntries(buildManifest(false));
    const modelFirst = selectApiClientEntries(buildManifest(true));

    const summarize = (entries: typeof collectionFirst) =>
      entries.map(({ clientKey, dataInterfaceName, obj }) => ({
        clientKey,
        dataInterfaceName,
        className: obj.className,
        fields: Object.keys(obj.fields),
      }));

    expect(summarize(collectionFirst)).toEqual(summarize(modelFirst));
    expect(summarize(collectionFirst)).toEqual([
      {
        clientKey: 'agreementExecutions',
        dataInterfaceName: 'AgreementExecutionData',
        className: 'AgreementExecution',
        fields: ['status', 'amount'],
      },
      {
        clientKey: 'agreementExecutionCollection',
        dataInterfaceName: 'AgreementExecutionData',
        className: 'AgreementExecutionCollection',
        fields: [],
      },
      {
        clientKey: 'contents',
        dataInterfaceName: 'ContentData',
        className: 'Content',
        fields: ['title'],
      },
      {
        clientKey: 'contents2',
        dataInterfaceName: 'ContentData',
        className: 'Contents',
        fields: [],
      },
    ]);
  });

  it('excludes api:false objects without changing canonical ownership or client keys', () => {
    const manifest = buildManifest(false);
    manifest.objects.HiddenAgreementExecution = {
      className: 'HiddenAgreementExecution',
      collection: 'agreementExecutions',
      extends: 'SmrtObject',
      fields: { secret: { type: 'text', required: true } },
      methods: {},
      decoratorConfig: { api: false },
    } as SmartObjectDefinition;
    manifest.objects.InternalCheckpoint = {
      className: 'InternalCheckpoint',
      collection: 'internalCheckpoints',
      extends: 'SmrtObject',
      fields: { cursor: { type: 'text', required: true } },
      methods: {},
      decoratorConfig: { api: false },
    } as SmartObjectDefinition;

    expect(
      selectApiClientEntries(manifest).map(({ clientKey, obj }) => [
        clientKey,
        obj.className,
      ]),
    ).toEqual([
      ['agreementExecutions', 'AgreementExecution'],
      ['agreementExecutionCollection', 'AgreementExecutionCollection'],
      ['contents', 'Content'],
      ['contents2', 'Contents'],
    ]);
  });

  it('keeps only routed companion collection methods when its item model has api:false', () => {
    const hiddenModel = {
      className: 'Secret',
      collection: 'secrets',
      extends: 'SmrtObject',
      fields: { value: { type: 'text', required: true } },
      methods: {},
      decoratorConfig: { api: false },
    } as SmartObjectDefinition;
    const implicitCollection = {
      className: 'SecretCollection',
      collection: 'secrets',
      extends: 'SmrtCollection',
      extendsTypeArg: 'Secret',
      fields: {},
      methods: {},
      decoratorConfig: {},
    } as SmartObjectDefinition;

    const implicitManifest = {
      version: '1.0.0',
      timestamp: 1,
      objects: {
        Secret: hiddenModel,
        SecretCollection: implicitCollection,
      },
    } satisfies SmartObjectManifest;

    expect(selectApiClientEntries(implicitManifest)).toEqual([]);

    const customOnlyEntries = selectApiClientEntries({
      ...implicitManifest,
      objects: {
        ...implicitManifest.objects,
        SecretCollection: {
          ...implicitCollection,
          methods: {
            reveal: {
              name: 'reveal',
              async: true,
              parameters: [],
              returnType: 'string',
              isStatic: false,
              isPublic: true,
            },
          },
        },
      },
    });
    expect(
      customOnlyEntries.map(({ clientKey, obj }) => [clientKey, obj.className]),
    ).toEqual([['secrets', 'SecretCollection']]);
    expect(customOnlyEntries[0]).toMatchObject({
      crudMethods: [],
      customMethods: [{ name: 'reveal', scope: 'collection' }],
    });

    const overrideEntry = selectApiClientEntries({
      ...implicitManifest,
      objects: {
        ...implicitManifest.objects,
        SecretCollection: {
          ...implicitCollection,
          methods: {
            reveal: {
              name: 'reveal',
              async: true,
              parameters: [],
              returnType: 'string',
              isStatic: false,
              isPublic: true,
            },
          },
          decoratorConfig: {
            api: {
              routes: {
                reveal: { scope: 'item' },
              },
            },
          },
        },
      },
    })[0];
    expect(overrideEntry).toMatchObject({
      crudMethods: [],
      customMethods: [{ name: 'reveal', scope: 'collection' }],
    });

    expect(
      selectApiClientEntries({
        ...implicitManifest,
        objects: {
          ...implicitManifest.objects,
          SecretCollection: {
            ...implicitCollection,
            decoratorConfig: { api: true },
          },
        },
      }),
    ).toEqual([]);
  });

  it('prefers an inherited generic item over a subclass naming collision', () => {
    const manifest = {
      version: '1.0.0',
      timestamp: 1,
      objects: {
        Widget: {
          className: 'Widget',
          collection: 'widgets',
          extends: 'SmrtObject',
          fields: {},
          methods: {},
          decoratorConfig: { api: false },
        },
        SpecialWidget: {
          className: 'SpecialWidget',
          collection: 'specialWidgets',
          extends: 'SmrtObject',
          fields: {},
          methods: {},
          decoratorConfig: { api: false },
        },
        WidgetCollection: {
          className: 'WidgetCollection',
          collection: 'widgets',
          extends: 'SmrtCollection',
          extendsTypeArg: 'Widget',
          fields: {},
          methods: {},
          decoratorConfig: { api: false },
        },
        SpecialWidgetCollection: {
          className: 'SpecialWidgetCollection',
          collection: 'widgets',
          extends: 'WidgetCollection',
          fields: {},
          methods: {
            restoreSpecial: {
              name: 'restoreSpecial',
              async: true,
              parameters: [],
              returnType: 'Widget[]',
              isStatic: false,
              isPublic: true,
            },
          },
          decoratorConfig: {
            api: { include: ['restoreSpecial'] },
          },
        },
      },
    } satisfies SmartObjectManifest;

    const entry = selectApiClientEntries(manifest).find(
      ({ obj }) => obj.className === 'SpecialWidgetCollection',
    );
    expect(entry).toMatchObject({
      clientKey: 'widgets',
      dataInterfaceName: 'WidgetData',
      customMethods: [{ name: 'restoreSpecial', scope: 'collection' }],
    });
  });

  it('carries the exact standard action set for partial and custom-only APIs', () => {
    const manifest = buildManifest(false);
    manifest.objects.AgreementExecution = {
      ...agreementExecution,
      methods: {
        reveal: {
          name: 'reveal',
          async: true,
          parameters: [],
          returnType: 'string',
          isStatic: false,
          isPublic: true,
        },
      },
      decoratorConfig: {
        api: {
          include: ['get', 'update', 'reveal'],
          exclude: ['update'],
        },
      },
    };

    const entries = selectApiClientEntries(manifest).filter(
      ({ obj }) => obj.collection === 'agreementExecutions',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      clientKey: 'agreementExecutions',
      crudMethods: ['get'],
      customMethods: [{ name: 'reveal', scope: 'item' }],
    });
    expect(entries[1]).toMatchObject({
      clientKey: 'agreementExecutionCollection',
      crudMethods: ['get'],
    });
  });

  it('uses a transitive canonical rank for mixed STI and unrelated models', () => {
    const entries: Array<[string, SmartObjectDefinition]> = [
      [
        'ZBase',
        {
          className: 'ZBase',
          collection: 'shared',
          extends: 'SmrtObject',
          fields: { base: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
      [
        'AChild',
        {
          className: 'AChild',
          collection: 'shared',
          extends: 'ZBase',
          fields: { child: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
      [
        'MOther',
        {
          className: 'MOther',
          collection: 'shared',
          extends: 'SmrtObject',
          fields: { other: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
    ];

    const selections = permutations(entries).map((objects) =>
      selectApiClientEntries({
        version: '1.0.0',
        timestamp: 1,
        objects: Object.fromEntries(objects),
      }),
    );

    for (const selection of selections) {
      expect(
        selection.map(({ clientKey, obj }) => [clientKey, obj.className]),
      ).toEqual([
        ['shared', 'ZBase'],
        ['aChild', 'AChild'],
        ['mOther', 'MOther'],
      ]);
    }
  });

  it('matches CRUD aliases to the route files actually emitted for a shared collection', () => {
    const base = {
      className: 'RecordBase',
      collection: 'records',
      extends: 'SmrtObject',
      fields: { base: { type: 'text' } },
      methods: {},
      decoratorConfig: {
        tableStrategy: 'sti',
        api: { include: ['list', 'get', 'create'] },
      },
    } as SmartObjectDefinition;
    const child = {
      className: 'RecordChild',
      collection: 'records',
      extends: 'RecordBase',
      fields: { child: { type: 'text' } },
      methods: {},
      decoratorConfig: { api: { include: ['get', 'update'] } },
    } as SmartObjectDefinition;

    const summarize = (
      objects: Record<string, SmartObjectDefinition>,
    ): Array<[string, ApiClientCrudMethod[]]> =>
      selectApiClientEntries({
        version: '1.0.0',
        timestamp: 1,
        objects,
      }).map(({ clientKey, crudMethods }) => [clientKey, crudMethods]);

    // Base writes the collection file; the later child replaces the item file.
    expect(summarize({ RecordBase: base, RecordChild: child })).toEqual([
      ['records', ['list', 'get', 'create', 'update']],
      ['recordChild', ['list', 'get', 'create', 'update']],
    ]);

    // Reversing manifest order makes the base the final writer of both files.
    expect(summarize({ RecordChild: child, RecordBase: base })).toEqual([
      ['records', ['list', 'get', 'create']],
      ['recordChild', ['list', 'get', 'create']],
    ]);
  });

  it('resolves duplicate simple parent names deterministically across packages', () => {
    const entries: Array<[string, SmartObjectDefinition]> = [
      [
        '@a/pkg:Item',
        {
          qualifiedName: '@a/pkg:Item',
          packageName: '@a/pkg',
          className: 'Item',
          collection: 'items',
          extends: 'SmrtObject',
          fields: { value: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
      [
        '@a/pkg:Parent',
        {
          qualifiedName: '@a/pkg:Parent',
          packageName: '@a/pkg',
          className: 'Parent',
          collection: 'collectionParents',
          extends: 'SmrtCollection',
          extendsTypeArg: 'Item',
          fields: {},
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
      [
        '@z/pkg:Parent',
        {
          qualifiedName: '@z/pkg:Parent',
          packageName: '@z/pkg',
          className: 'Parent',
          collection: 'modelParents',
          extends: 'SmrtObject',
          fields: { label: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
      [
        '@c/pkg:FallbackChild',
        {
          qualifiedName: '@c/pkg:FallbackChild',
          packageName: '@c/pkg',
          className: 'FallbackChild',
          collection: 'fallbackChildren',
          extends: 'Parent',
          fields: {},
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
      [
        '@z/pkg:LocalChild',
        {
          qualifiedName: '@z/pkg:LocalChild',
          packageName: '@z/pkg',
          className: 'LocalChild',
          collection: 'localChildren',
          extends: 'Parent',
          fields: { local: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
      [
        '@c/pkg:QualifiedChild',
        {
          qualifiedName: '@c/pkg:QualifiedChild',
          packageName: '@c/pkg',
          className: 'QualifiedChild',
          collection: 'qualifiedChildren',
          extends: 'Parent',
          extendsQualified: '@z/pkg:Parent',
          fields: { qualified: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
      ],
    ];

    const summarize = (objects: Array<[string, SmartObjectDefinition]>) =>
      selectApiClientEntries({
        version: '1.0.0',
        timestamp: 1,
        objects: Object.fromEntries(objects),
      }).map(({ obj, clientKey, dataInterfaceName }) => ({
        qualifiedName: obj.qualifiedName,
        clientKey,
        dataInterfaceName,
      }));

    const forward = summarize(entries);
    const reversed = summarize([...entries].reverse());

    expect(forward).toEqual(reversed);
    expect(
      forward.find(
        ({ qualifiedName }) => qualifiedName === '@c/pkg:FallbackChild',
      ),
    ).toMatchObject({ dataInterfaceName: 'ItemData' });
    expect(
      forward.find(
        ({ qualifiedName }) => qualifiedName === '@z/pkg:LocalChild',
      ),
    ).toMatchObject({ dataInterfaceName: 'LocalChildData' });
    expect(
      forward.find(
        ({ qualifiedName }) => qualifiedName === '@c/pkg:QualifiedChild',
      ),
    ).toMatchObject({ dataInterfaceName: 'QualifiedChildData' });
  });
});
