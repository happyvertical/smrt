import { describe, expect, it } from 'vitest';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { selectApiClientEntries } from './api-client-entries.js';

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
