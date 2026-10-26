import type { DataQuerySchema } from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import {
  DataQueryValidationError,
  MAX_DATA_QUERY_FIELD_VALUE_LABEL_LENGTH,
  MAX_DATA_QUERY_FIELD_VALUE_LENGTH,
  MAX_DATA_QUERY_FIELD_VALUES,
  normalizeDataQueryFieldValues,
  normalizeDataQueryRequest,
  normalizeDataQuerySchema,
} from './data-query';

/** #4381: host-declared allowed values on data-query fields. */
const schema: DataQuerySchema = {
  version: 1,
  identityField: 'id',
  fields: [
    { id: 'id', type: 'string', filterOperators: ['eq'] },
    {
      id: 'status',
      type: 'string',
      filterOperators: ['eq', 'ne', 'in', 'notIn', 'like'],
      values: [
        { value: 'pending', label: 'Open', description: 'Not started yet' },
        { value: 'in_progress', label: 'Open' },
        { value: 'done', label: 'Closed' },
      ],
    },
    {
      id: 'priority',
      type: 'number',
      filterOperators: ['eq', 'in', 'gt'],
      values: [{ value: 1 }, { value: 2 }, { value: 3 }],
    },
  ],
};

function withValues(type: string, values: unknown): unknown {
  return {
    version: 1,
    identityField: 'id',
    fields: [
      { id: 'id', type: 'string' },
      { id: 'field', type, values },
    ],
  };
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

/** Build unsafe characters at runtime so none appears literally in source. */
function ch(code: number): string {
  return String.fromCharCode(code);
}

function condition(field: string, operator: string, value: unknown) {
  return {
    version: 1,
    requestId: 'r',
    mode: 'count',
    filter: { kind: 'condition', field, operator, value },
  };
}

describe('data-query allowed values (#4381)', () => {
  it('normalizes declared values in declaration order with labels', () => {
    const normalized = normalizeDataQuerySchema(schema);
    const status = normalized.fields.find((field) => field.id === 'status');
    expect(status?.values).toEqual([
      { value: 'pending', label: 'Open', description: 'Not started yet' },
      { value: 'in_progress', label: 'Open' },
      { value: 'done', label: 'Closed' },
    ]);
    expect(
      normalized.fields.find((field) => field.id === 'id'),
    ).not.toHaveProperty('values');
  });

  it('accepts boolean values on boolean fields', () => {
    expect(
      normalizeDataQueryFieldValues(
        [{ value: true, label: 'Archived' }, { value: false }],
        'boolean',
        'archived',
      ),
    ).toEqual([{ value: true, label: 'Archived' }, { value: false }]);
  });

  it.each([
    ['datetime', [{ value: '2026-01-01T00:00:00Z' }]],
    ['json', [{ value: 'x' }]],
  ])('rejects values on %s fields', (type, values) => {
    expect(
      rejection(() => normalizeDataQuerySchema(withValues(type, values)))
        .message,
    ).toMatch(/only supported on string, number, or boolean fields/);
  });

  it.each([
    ['an empty list', 'string', []],
    ['a non-array', 'string', 'pending'],
    ['a bare scalar entry', 'string', ['pending']],
    ['a type mismatch', 'string', [{ value: 1 }]],
    ['a non-finite number', 'number', [{ value: Number.NaN }]],
    ['a string on a boolean field', 'boolean', [{ value: 'true' }]],
    ['an empty string', 'string', [{ value: '' }]],
    ['a duplicate', 'string', [{ value: 'a' }, { value: 'a' }]],
    ['an unknown key', 'string', [{ value: 'a', color: 'red' }]],
    ['a non-string label', 'string', [{ value: 'a', label: 1 }]],
  ])('rejects %s', (_name, type, values) => {
    rejection(() => normalizeDataQuerySchema(withValues(type, values)));
  });

  it('bounds the value count and text lengths', () => {
    const tooMany = Array.from(
      { length: MAX_DATA_QUERY_FIELD_VALUES + 1 },
      (_, index) => ({ value: `v${index}` }),
    );
    expect(
      rejection(() => normalizeDataQuerySchema(withValues('string', tooMany)))
        .message,
    ).toMatch(`cannot exceed ${MAX_DATA_QUERY_FIELD_VALUES} entries`);
    expect(() =>
      normalizeDataQuerySchema(
        withValues('string', tooMany.slice(0, MAX_DATA_QUERY_FIELD_VALUES)),
      ),
    ).not.toThrow();
    rejection(() =>
      normalizeDataQuerySchema(
        withValues('string', [
          { value: 'x'.repeat(MAX_DATA_QUERY_FIELD_VALUE_LENGTH + 1) },
        ]),
      ),
    );
    rejection(() =>
      normalizeDataQuerySchema(
        withValues('string', [
          {
            value: 'x',
            label: 'x'.repeat(MAX_DATA_QUERY_FIELD_VALUE_LABEL_LENGTH + 1),
          },
        ]),
      ),
    );
  });

  it.each([
    ['a control character in a value', { value: `a${ch(0x00)}b` }],
    ['a newline in a label', { value: 'a', label: `line${ch(0x0a)}break` }],
    ['a C1 control in a description', { value: 'a', description: ch(0x85) }],
    ['a bidi override in a value', { value: `a${ch(0x202e)}b` }],
    ['a bidi isolate in a label', { value: 'a', label: `${ch(0x2066)}x` }],
    ['a zero-width space in a value', { value: `a${ch(0x200b)}b` }],
    [
      'a line separator in a description',
      { value: 'a', description: ch(0x2028) },
    ],
  ])('rejects %s', (_name, entry) => {
    expect(
      rejection(() => normalizeDataQuerySchema(withValues('string', [entry])))
        .message,
    ).toMatch(/control, format, or bidirectional characters/);
  });

  it('accepts declared eq/ne/in/notIn values and null', () => {
    expect(() =>
      normalizeDataQueryRequest(condition('status', 'eq', 'pending'), schema),
    ).not.toThrow();
    expect(() =>
      normalizeDataQueryRequest(condition('status', 'ne', null), schema),
    ).not.toThrow();
    expect(
      normalizeDataQueryRequest(
        condition('status', 'in', ['in_progress', 'pending']),
        schema,
      ).filter,
    ).toEqual({
      kind: 'condition',
      field: 'status',
      operator: 'in',
      value: ['in_progress', 'pending'],
    });
    expect(() =>
      normalizeDataQueryRequest(condition('priority', 'in', [1, 3]), schema),
    ).not.toThrow();
  });

  it.each([
    ['eq', 'open'],
    ['ne', 'open'],
    ['in', ['pending', 'open']],
    ['notIn', ['open']],
  ])('rejects an undeclared %s value with the allowed list', (op, value) => {
    const error = rejection(() =>
      normalizeDataQueryRequest(condition('status', op, value), schema),
    );
    expect(error.code).toBe('DATA_QUERY_VALUE_NOT_ALLOWED');
    expect(error.message).toContain(
      'use one of: "pending", "in_progress", "done"',
    );
    expect(error.details).toEqual({
      field: 'status',
      allowedValues: ['pending', 'in_progress', 'done'],
    });
  });

  it('leaves range and like operators unconstrained by declared values', () => {
    expect(() =>
      normalizeDataQueryRequest(condition('status', 'like', 'pen%'), schema),
    ).not.toThrow();
    expect(() =>
      normalizeDataQueryRequest(condition('priority', 'gt', 10), schema),
    ).not.toThrow();
  });

  it('accepts any value for an advisory set (valuesEnforced: false)', () => {
    const advisory = {
      ...schema,
      fields: schema.fields.map((field) =>
        field.id === 'status' ? { ...field, valuesEnforced: false } : field,
      ),
    };
    const status = normalizeDataQuerySchema(advisory).fields.find(
      (field) => field.id === 'status',
    );
    expect(status?.valuesEnforced).toBe(false);
    expect(status?.values).toHaveLength(3);
    expect(() =>
      normalizeDataQueryRequest(condition('status', 'eq', 'legacy'), advisory),
    ).not.toThrow();
    expect(() =>
      normalizeDataQueryRequest(
        condition('status', 'in', ['legacy', 'pending']),
        advisory,
      ),
    ).not.toThrow();
  });

  it('treats valuesEnforced: true as the default and omits it', () => {
    const enforced = {
      ...schema,
      fields: schema.fields.map((field) =>
        field.id === 'status' ? { ...field, valuesEnforced: true } : field,
      ),
    };
    expect(
      normalizeDataQuerySchema(enforced).fields.find(
        (field) => field.id === 'status',
      ),
    ).not.toHaveProperty('valuesEnforced');
    expect(
      rejection(() =>
        normalizeDataQueryRequest(condition('status', 'eq', 'open'), enforced),
      ).code,
    ).toBe('DATA_QUERY_VALUE_NOT_ALLOWED');
  });

  it('rejects a malformed or orphaned valuesEnforced', () => {
    expect(
      rejection(() =>
        normalizeDataQuerySchema({
          version: 1,
          identityField: 'id',
          fields: [
            { id: 'id', type: 'string' },
            { id: 'field', type: 'string', valuesEnforced: false },
          ],
        }),
      ).message,
    ).toMatch(/valuesEnforced requires values/);
    expect(
      rejection(() =>
        normalizeDataQuerySchema({
          version: 1,
          identityField: 'id',
          fields: [
            { id: 'id', type: 'string' },
            {
              id: 'field',
              type: 'string',
              values: [{ value: 'a' }],
              valuesEnforced: 'no',
            },
          ],
        }),
      ).message,
    ).toMatch(/valuesEnforced must be boolean/);
  });

  it('truncates long allowed-value lists in the message', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      value: `v${index}`,
    }));
    const wide = {
      version: 1,
      identityField: 'id',
      fields: [
        { id: 'id', type: 'string' },
        { id: 'code', type: 'string', filterOperators: ['eq'], values: many },
      ],
    };
    const error = rejection(() =>
      normalizeDataQueryRequest(condition('code', 'eq', 'nope'), wide),
    );
    expect(error.message).toMatch(/"v19", and 10 more$/);
    expect(
      (error.details as { allowedValues: unknown[] }).allowedValues,
    ).toHaveLength(30);
  });
});
