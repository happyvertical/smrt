import type { DataQuerySchema } from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeDataQuery,
  createDataQueryFingerprint,
  DataQueryValidationError,
  normalizeDataQueryRequest,
  normalizeDataQuerySchema,
} from './data-query';

/** #4448: `isNull` / `isNotNull` null tests on `condition` filters. */
const schema: DataQuerySchema = {
  version: 1,
  identityField: 'id',
  fields: [
    { id: 'id', type: 'string', filterOperators: ['eq', 'in'] },
    {
      id: 'endedAt',
      type: 'datetime',
      filterOperators: ['eq', 'ne', 'gt', 'isNull', 'isNotNull'],
    },
    {
      id: 'status',
      type: 'string',
      filterOperators: ['eq', 'ne', 'in', 'notIn', 'isNull', 'isNotNull'],
      values: [{ value: 'active' }, { value: 'break' }],
    },
    // Not nullable: no null test declared.
    { id: 'employee', type: 'string', filterOperators: ['eq', 'like'] },
  ],
};

function request(filter: unknown) {
  return { version: 1, requestId: 'r', mode: 'count', filter };
}

function rejection(fn: () => unknown): DataQueryValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DataQueryValidationError);
    return error as DataQueryValidationError;
  }
  throw new Error('expected a DataQueryValidationError');
}

describe('data-query null tests (#4448)', () => {
  it('accepts the operators in a schema and sorts them deterministically', () => {
    const normalized = normalizeDataQuerySchema(schema);
    expect(
      normalized.fields.find((field) => field.id === 'endedAt')
        ?.filterOperators,
    ).toEqual(['eq', 'gt', 'isNotNull', 'isNull', 'ne']);
  });

  it('normalizes a null test to a condition without a value', () => {
    for (const operator of ['isNull', 'isNotNull'] as const) {
      const normalized = normalizeDataQueryRequest(
        request({ kind: 'condition', field: 'endedAt', operator }),
        schema,
      );
      expect(normalized.filter).toEqual({
        kind: 'condition',
        field: 'endedAt',
        operator,
      });
      expect(normalized.filter && 'value' in normalized.filter).toBe(false);
    }
  });

  it('drops an explicit null value so both spellings share one fingerprint', () => {
    const bare = request({
      kind: 'condition',
      field: 'endedAt',
      operator: 'isNull',
    });
    const withNull = request({
      kind: 'condition',
      field: 'endedAt',
      operator: 'isNull',
      value: null,
    });
    expect(normalizeDataQueryRequest(withNull, schema).filter).toEqual(
      normalizeDataQueryRequest(bare, schema).filter,
    );
    expect(createDataQueryFingerprint(withNull, schema)).toBe(
      createDataQueryFingerprint(bare, schema),
    );
    expect(canonicalizeDataQuery(bare, schema)).toBe(
      '{"filter":{"field":"endedAt","kind":"condition","operator":"isNull"},"mode":"count","version":1}',
    );
  });

  it('gives isNull, isNotNull, and eq null distinct fingerprints', () => {
    const fingerprints = new Set(
      [
        { operator: 'isNull' },
        { operator: 'isNotNull' },
        { operator: 'eq', value: null },
        { operator: 'ne', value: null },
      ].map((condition) =>
        createDataQueryFingerprint(
          request({ kind: 'condition', field: 'endedAt', ...condition }),
          schema,
        ),
      ),
    );
    expect(fingerprints.size).toBe(4);
  });

  it('leaves the canonical form of an existing eq null request unchanged', () => {
    // `eq null` predates the null tests and keeps its meaning and canonical form.
    expect(
      canonicalizeDataQuery(
        request({
          kind: 'condition',
          field: 'endedAt',
          operator: 'eq',
          value: null,
        }),
        schema,
      ),
    ).toBe(
      '{"filter":{"field":"endedAt","kind":"condition","operator":"eq","value":null},"mode":"count","version":1}',
    );
  });

  it('rejects a non-null value with the valueless shape', () => {
    for (const value of ['null', [], false, 0]) {
      const error = rejection(() =>
        normalizeDataQueryRequest(
          request({
            kind: 'condition',
            field: 'endedAt',
            operator: 'isNotNull',
            value,
          }),
          schema,
        ),
      );
      expect(error.code).toBe('INVALID_DATA_QUERY');
      expect(error.message).toContain(
        'isNotNull takes no value; omit value: {"kind":"condition","field":"endedAt","operator":"isNotNull"}',
      );
    }
  });

  it('refuses a null test the field does not declare', () => {
    const error = rejection(() =>
      normalizeDataQueryRequest(
        request({ kind: 'condition', field: 'employee', operator: 'isNull' }),
        schema,
      ),
    );
    expect(error.code).toBe('DATA_QUERY_OPERATOR_NOT_ALLOWED');
  });

  it('bypasses allowed-value enforcement (#4381)', () => {
    const normalized = normalizeDataQueryRequest(
      request({ kind: 'condition', field: 'status', operator: 'isNull' }),
      schema,
    );
    expect(normalized.filter).toEqual({
      kind: 'condition',
      field: 'status',
      operator: 'isNull',
    });
    // A value outside the set is still refused on a value operator.
    expect(
      rejection(() =>
        normalizeDataQueryRequest(
          request({
            kind: 'condition',
            field: 'status',
            operator: 'eq',
            value: 'gone',
          }),
          schema,
        ),
      ).code,
    ).toBe('DATA_QUERY_VALUE_NOT_ALLOWED');
  });

  it('canonicalizes a nested all of in and isNull independent of order', () => {
    const inStatus = {
      kind: 'condition',
      field: 'status',
      operator: 'in',
      value: ['break', 'active'],
    };
    const isNull = { kind: 'condition', field: 'endedAt', operator: 'isNull' };
    const forward = request({ kind: 'all', filters: [inStatus, isNull] });
    const reverse = request({
      kind: 'all',
      filters: [{ ...isNull, value: null }, inStatus],
    });
    expect(normalizeDataQueryRequest(forward, schema).filter).toEqual({
      kind: 'all',
      filters: [
        { kind: 'condition', field: 'endedAt', operator: 'isNull' },
        {
          kind: 'condition',
          field: 'status',
          operator: 'in',
          value: ['active', 'break'],
        },
      ],
    });
    expect(createDataQueryFingerprint(reverse, schema)).toBe(
      createDataQueryFingerprint(forward, schema),
    );
    expect(
      normalizeDataQueryRequest(
        request({ kind: 'not', filter: isNull }),
        schema,
      ).filter,
    ).toEqual({ kind: 'not', filter: isNull });
  });
});
