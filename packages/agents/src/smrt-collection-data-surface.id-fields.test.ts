/**
 * Id (native UUID column) fields and NULL ordering in the generic collection
 * adapter: queries that used to reach PostgreSQL and fail there as a 500/502
 * (`uuid ~~ text`, `invalid input syntax for type uuid`, a NULL sort value
 * out of the contract's order) are now shaped or refused up front.
 */
import {
  DataQueryValidationError,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type { DataQueryFilter } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDataQuerySchemaForClass,
  clearSmrtCollectionQuerySchemaCache,
  dataQueryOrderByTerms,
  executeSmrtCollectionQuery,
  type SmrtCollectionQueryCollection,
} from './smrt-collection-data-surface.js';

const QUALIFIED_NAME = '@happyvertical/smrt-agents:SmrtSurfaceIdFixture';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

function registerFixture(): void {
  ObjectRegistry.registerFromManifest(
    'SmrtSurfaceIdFixture',
    {
      className: 'SmrtSurfaceIdFixture',
      fields: {
        id: { type: 'text' },
        parentId: { type: 'foreignKey' },
        name: { type: 'text' },
      },
      methods: {},
      decoratorConfig: { tableName: 'smrt_surface_id_fixtures' },
      schema: {
        tableName: 'smrt_surface_id_fixtures',
        ddl: '',
        columns: {
          id: { type: 'UUID' },
          parent_id: { type: 'UUID' },
          name: { type: 'TEXT' },
        },
        indexes: [],
        version: 'test',
      },
    } as never,
    '@happyvertical/smrt-agents',
  );
}

function recordingCollection() {
  const list = vi.fn(async (_options: Record<string, unknown>) => []);
  const collection: SmrtCollectionQueryCollection = {
    list,
    async count() {
      return 0;
    },
  };
  return { collection, list };
}

async function schema() {
  return buildDataQuerySchemaForClass(QUALIFIED_NAME, {
    exclude: ['context', 'created_at', 'slug', 'updated_at'],
  });
}

async function run(filter: DataQueryFilter) {
  const { collection, list } = recordingCollection();
  const result = executeSmrtCollectionQuery(
    collection,
    { version: 1, requestId: 'r', mode: 'rows', filter },
    { schema: await schema(), qualifiedName: QUALIFIED_NAME },
  );
  return { result, list };
}

describe('id fields', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerFixture();
  });
  afterEach(() => {
    ObjectRegistry.clear();
    clearSmrtCollectionQuerySchemaCache();
  });

  it('offers only equality operators on UUID columns', async () => {
    const byId = new Map((await schema()).fields.map((f) => [f.id, f]));
    expect(byId.get('id')?.filterOperators).toEqual([
      'eq',
      'in',
      'ne',
      'notIn',
    ]);
    expect(byId.get('parentId')?.filterOperators).toEqual([
      'eq',
      'in',
      'ne',
      'notIn',
    ]);
    expect(byId.get('name')?.filterOperators).toContain('like');
  });

  it('refuses a non-UUID value before the database sees it', async () => {
    const { result, list } = await run({
      kind: 'condition',
      field: 'parentId',
      operator: 'in',
      value: [UUID, 'abc'],
    });
    await expect(result).rejects.toBeInstanceOf(DataQueryValidationError);
    await expect(result).rejects.toMatchObject({
      code: 'DATA_QUERY_VALUE_INVALID',
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('passes a UUID value and a null through', async () => {
    const { result, list } = await run({
      kind: 'any',
      filters: [
        { kind: 'condition', field: 'id', operator: 'eq', value: UUID },
        { kind: 'condition', field: 'parentId', operator: 'eq', value: null },
      ],
    });
    await expect(result).resolves.toMatchObject({ rows: [] });
    expect(list).toHaveBeenCalledOnce();
  });
});

describe('dataQueryOrderByTerms', () => {
  it('places NULLs where the data-query contract orders them', () => {
    expect(
      dataQueryOrderByTerms([
        { field: 'publishedAt', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ]),
    ).toEqual(['publishedAt DESC NULLS LAST', 'id ASC NULLS FIRST']);
    expect(dataQueryOrderByTerms([])).toBeUndefined();
  });
});
