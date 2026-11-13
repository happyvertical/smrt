import { describe, expect, it } from 'vitest';
import { createSqliteReferenceTarget } from '../../testing.js';
import {
  type ImportPlan,
  ImportPlanError,
  type ImportPlanErrorCode,
  loadOrder,
  runImport,
  validatePlan,
} from '../index.js';
import { planOf, sheetOf, workbookOf } from './helpers.js';

const valid = (): ImportPlan =>
  planOf([
    {
      key: 'parents',
      label: 'Parents',
      source: { sheet: 'S', range: 'A1:B5', headerRow: 1 },
      lookupKey: ['name'],
      titleField: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text', column: 1 },
        { key: 'qty', label: 'Qty', type: 'integer', column: 2 },
        {
          key: 'double',
          label: 'Double',
          type: 'integer',
          calculated: { op: 'mul', left: { col: 'qty' }, right: { value: 2 } },
        },
      ],
    },
    {
      key: 'kids',
      label: 'Kids',
      source: { sheet: 'K', range: 'A1:B5', headerRow: 1 },
      fields: [
        { key: 'label', label: 'Label', type: 'text', column: 1 },
        {
          key: 'parent',
          label: 'Parent',
          type: 'reference',
          reference: { table: 'parents', by: ['name'], columns: [2] },
        },
      ],
    },
  ]);

/** A deep clone with one edit applied, so each case starts from a valid plan. */
function mutated(edit: (plan: any) => void): unknown {
  const plan = structuredClone(valid());
  edit(plan);
  return plan;
}

function refusal(input: unknown): ImportPlanError {
  try {
    validatePlan(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ImportPlanError);
    return error as ImportPlanError;
  }
  throw new Error('the plan was accepted');
}

describe('validatePlan', () => {
  it('accepts a valid plan and returns a clean copy', () => {
    const input = valid();
    const plan = validatePlan(input);
    expect(plan).toEqual(input);
    expect(plan).not.toBe(input);
    expect(loadOrder(plan)).toEqual(['parents', 'kids']);
  });

  const cases: Array<[string, unknown, ImportPlanErrorCode, string]> = [
    [
      'a function',
      mutated((p) => {
        p.tables[0].fields[0].label = () => 'x';
      }),
      'plan-not-data',
      '',
    ],
    [
      'a cyclic value',
      (() => {
        const p: any = valid();
        p.self = p;
        return p;
      })(),
      'plan-not-data',
      '',
    ],
    ['not an object', 'plan', 'invalid-shape', ''],
    [
      'a wrong version',
      mutated((p) => {
        p.version = 2;
      }),
      'unsupported-version',
      'version',
    ],
    [
      'an unknown plan key',
      mutated((p) => {
        p.sql = 'drop table x';
      }),
      'unknown-key',
      '.sql',
    ],
    [
      'an unknown table key',
      mutated((p) => {
        p.tables[0].path = '/etc';
      }),
      'unknown-key',
      'tables[0].path',
    ],
    [
      'an unknown field key',
      mutated((p) => {
        p.tables[0].fields[0].fn = 'x';
      }),
      'unknown-key',
      'tables[0].fields[0].fn',
    ],
    [
      'an unknown source key',
      mutated((p) => {
        p.tables[0].source.file = 'x';
      }),
      'unknown-key',
      'tables[0].source.file',
    ],
    [
      'a bad table key',
      mutated((p) => {
        p.tables[0].key = 'Bad-Key';
      }),
      'invalid-key',
      'tables[0].key',
    ],
    [
      'a table key too long',
      mutated((p) => {
        p.tables[0].key = `a${'b'.repeat(63)}`;
      }),
      'invalid-key',
      'tables[0].key',
    ],
    [
      'a bad field key',
      mutated((p) => {
        p.tables[0].fields[0].key = '1abc';
      }),
      'invalid-key',
      'tables[0].fields[0].key',
    ],
    [
      'the constructor key',
      mutated((p) => {
        p.tables[0].fields[0].key = 'constructor';
      }),
      'reserved-key',
      'tables[0].fields[0].key',
    ],
    [
      'the prototype key',
      mutated((p) => {
        p.tables[0].key = 'prototype';
      }),
      'reserved-key',
      'tables[0].key',
    ],
    [
      'a duplicate table key',
      mutated((p) => {
        p.tables[1].key = 'parents';
      }),
      'duplicate-key',
      'tables[1].key',
    ],
    [
      'a duplicate field key',
      mutated((p) => {
        p.tables[0].fields[1].key = 'name';
      }),
      'duplicate-key',
      'tables[0].fields[1].key',
    ],
    [
      'a duplicate report key',
      mutated((p) => {
        p.reports = [
          { key: 'r', label: 'R', spec: {} },
          { key: 'r', label: 'R', spec: {} },
        ];
      }),
      'duplicate-key',
      'reports[1].key',
    ],
    [
      'no source',
      mutated((p) => {
        delete p.tables[0].fields[0].column;
      }),
      'field-source',
      'tables[0].fields[0]',
    ],
    [
      'two sources',
      mutated((p) => {
        p.tables[0].fields[1].calculated = { value: 1 };
      }),
      'field-source',
      'tables[0].fields[1]',
    ],
    [
      'a column and a reference',
      mutated((p) => {
        p.tables[1].fields[1].column = 3;
      }),
      'field-source',
      'tables[1].fields[1]',
    ],
    [
      'a cached column on a plain field',
      mutated((p) => {
        p.tables[0].fields[0].cachedColumn = 3;
      }),
      'field-source',
      'tables[0].fields[0].cachedColumn',
    ],
    [
      'a reference typed as text',
      mutated((p) => {
        p.tables[1].fields[1].type = 'text';
      }),
      'field-source',
      'tables[1].fields[1].type',
    ],
    [
      'a lookup key on a calculated field',
      mutated((p) => {
        p.tables[0].lookupKey = ['double'];
      }),
      'field-source',
      'tables[0].lookupKey[0]',
    ],
    [
      'a lookup key naming no field',
      mutated((p) => {
        p.tables[0].lookupKey = ['nope'];
      }),
      'unknown-field',
      'tables[0].lookupKey[0]',
    ],
    [
      'a title naming no field',
      mutated((p) => {
        p.tables[0].titleField = 'nope';
      }),
      'unknown-field',
      'tables[0].titleField',
    ],
    [
      'a reference to no table',
      mutated((p) => {
        p.tables[1].fields[1].reference.table = 'nope';
      }),
      'unknown-table',
      'tables[1].fields[1].reference.table',
    ],
    [
      'a reference not matching the lookup key',
      mutated((p) => {
        p.tables[1].fields[1].reference.by = ['qty'];
      }),
      'reference-mismatch',
      'tables[1].fields[1].reference.by',
    ],
    [
      'a reference to a table with no lookup key',
      mutated((p) => {
        delete p.tables[0].lookupKey;
      }),
      'reference-mismatch',
      'tables[1].fields[1].reference.by',
    ],
    [
      'unpaired reference columns',
      mutated((p) => {
        p.tables[1].fields[1].reference.columns = [2, 3];
      }),
      'reference-mismatch',
      'tables[1].fields[1].reference.columns',
    ],
    [
      'a reference cycle',
      mutated((p) => {
        p.tables[0].fields.push({
          key: 'kid',
          label: 'Kid',
          type: 'reference',
          reference: { table: 'kids', by: ['label'], columns: [3] },
        });
        p.tables[1].lookupKey = ['label'];
      }),
      'reference-cycle',
      'tables',
    ],
    [
      'a self reference',
      mutated((p) => {
        p.tables[0].fields.push({
          key: 'boss',
          label: 'Boss',
          type: 'reference',
          reference: { table: 'parents', by: ['name'], columns: [3] },
        });
      }),
      'reference-cycle',
      'tables',
    ],
    [
      'an expression over an unknown column',
      mutated((p) => {
        p.tables[0].fields[2].calculated = { col: 'nope' };
      }),
      'expression-column',
      'tables[0].fields[2].calculated',
    ],
    [
      'an expression over a calculated field',
      mutated((p) => {
        p.tables[0].fields.push({
          key: 'triple',
          label: 'Triple',
          type: 'integer',
          calculated: {
            op: 'add',
            left: { col: 'double' },
            right: { col: 'qty' },
          },
        });
      }),
      'expression-column',
      'tables[0].fields[3].calculated',
    ],
    [
      'an expression over a reference field',
      mutated((p) => {
        p.tables[1].fields.push({
          key: 'x',
          label: 'X',
          type: 'text',
          calculated: { col: 'parent' },
        });
      }),
      'expression-column',
      'tables[1].fields[2].calculated',
    ],
    [
      'an unknown operator',
      mutated((p) => {
        p.tables[0].fields[2].calculated = { op: 'eval', code: 'x' };
      }),
      'invalid-expression',
      'tables[0].fields[2].calculated',
    ],
    [
      'a function as an expression value',
      mutated((p) => {
        p.tables[0].fields[2].calculated = {
          op: 'abs',
          value: { col: 'qty' },
          fn: 'x',
        };
      }),
      'invalid-expression',
      'tables[0].fields[2].calculated',
    ],
    [
      'an expression of the wrong type',
      mutated((p) => {
        p.tables[0].fields[2].calculated = {
          op: 'concat',
          operands: [{ col: 'name' }, { value: 'x' }],
        };
      }),
      'expression-type',
      'tables[0].fields[2].calculated',
    ],
    [
      'a bad A1 range',
      mutated((p) => {
        p.tables[0].source.range = 'A:B';
      }),
      'invalid-source',
      'tables[0].source.range',
    ],
    [
      'a SQL-looking sheet',
      mutated((p) => {
        p.tables[0].source.sheet = '';
      }),
      'invalid-source',
      'tables[0].source.sheet',
    ],
    [
      'a zero header row',
      mutated((p) => {
        p.tables[0].source.headerRow = 0;
      }),
      'invalid-value',
      'tables[0].source.headerRow',
    ],
    [
      'a repeated skip row',
      mutated((p) => {
        p.tables[0].source.skipRows = [3, 3];
      }),
      'duplicate-key',
      'tables[0].source.skipRows[1]',
    ],
    [
      'a column of zero',
      mutated((p) => {
        p.tables[0].fields[0].column = 0;
      }),
      'invalid-value',
      'tables[0].fields[0].column',
    ],
    [
      'a choice without choices',
      mutated((p) => {
        p.tables[0].fields[0].type = 'choice';
      }),
      'invalid-value',
      'tables[0].fields[0].choices',
    ],
    [
      'choices on a text field',
      mutated((p) => {
        p.tables[0].fields[0].choices = ['a'];
      }),
      'invalid-value',
      'tables[0].fields[0].choices',
    ],
    [
      'untrimmed choices',
      mutated((p) => {
        p.tables[0].fields[0].type = 'choice';
        p.tables[0].fields[0].choices = [' a'];
      }),
      'invalid-value',
      'tables[0].fields[0].choices[0]',
    ],
    [
      'money without money',
      mutated((p) => {
        p.tables[0].fields[1].type = 'money';
      }),
      'invalid-shape',
      'tables[0].fields[1].money',
    ],
    [
      'money with a bad scale',
      mutated((p) => {
        p.tables[0].fields[1].type = 'money';
        p.tables[0].fields[1].money = { currency: 'USD', scale: 9 };
      }),
      'invalid-value',
      'tables[0].fields[1].money.scale',
    ],
    [
      'money with a bad currency',
      mutated((p) => {
        p.tables[0].fields[1].type = 'money';
        p.tables[0].fields[1].money = { currency: 'usd', scale: 2 };
      }),
      'invalid-value',
      'tables[0].fields[1].money.currency',
    ],
    [
      'money on a text field',
      mutated((p) => {
        p.tables[0].fields[0].money = { currency: 'USD', scale: 2 };
      }),
      'invalid-value',
      'tables[0].fields[0].money',
    ],
    [
      'an unknown type',
      mutated((p) => {
        p.tables[0].fields[0].type = 'blob';
      }),
      'invalid-value',
      'tables[0].fields[0].type',
    ],
    [
      'no tables',
      mutated((p) => {
        p.tables = [];
      }),
      'invalid-value',
      'tables',
    ],
    [
      'a table without fields',
      mutated((p) => {
        p.tables[0].fields = [];
      }),
      'invalid-value',
      'tables[0].fields',
    ],
  ];

  it.each(cases)('refuses %s', (_name, input, code, path) => {
    const error = refusal(input);
    expect(error.code).toBe(code);
    if (path) expect(error.path.endsWith(path)).toBe(true);
  });

  it('refuses limits that are exceeded, and lets a caller raise them', () => {
    const many = mutated((p) => {
      for (let i = 0; i < 3; i++) {
        p.tables.push({
          ...structuredClone(p.tables[0]),
          key: `extra_${i}`,
          lookupKey: undefined,
          titleField: undefined,
          fields: [{ key: 'a', label: 'A', type: 'text', column: 1 }],
        });
      }
    });
    expect(() => validatePlan(many, { maxTables: 4 })).toThrowError(
      expect.objectContaining({ code: 'limit-exceeded', path: 'tables' }),
    );
    expect(validatePlan(many, { maxTables: 5 }).tables).toHaveLength(5);

    const wide = mutated((p) => {
      p.tables[0].fields = Array.from({ length: 501 }, (_, i) => ({
        key: `f${i}`,
        label: 'F',
        type: 'text',
        column: 1,
      }));
      p.tables[0].lookupKey = undefined;
      p.tables[0].titleField = undefined;
    });
    expect(refusal(wide).code).toBe('limit-exceeded');

    const big = mutated((p) => {
      p.reports = [{ key: 'r', label: 'R', spec: 'x'.repeat(2 * 1024 * 1024) }];
    });
    expect(refusal(big).code).toBe('plan-too-large');
    expect(
      validatePlan(big, { maxPlanBytes: 3 * 1024 * 1024 }).reports,
    ).toHaveLength(1);

    const deep = mutated((p) => {
      let node: any = { col: 'qty' };
      for (let i = 0; i < 40; i++) node = { op: 'abs', value: node };
      p.tables[0].fields[2].calculated = node;
    });
    expect(refusal(deep).code).toBe('invalid-expression');
  });

  it('refuses prototype-pollution keys wherever they appear', () => {
    const polluted = JSON.parse(
      JSON.stringify(valid()).replace(
        '"label":"Parents"',
        '"label":"Parents","__proto__":{"admin":true}',
      ),
    );
    expect(Object.hasOwn(polluted.tables[0], '__proto__')).toBe(true);
    expect(refusal(polluted)).toMatchObject({
      code: 'unknown-key',
      path: 'tables[0].__proto__',
    });
    expect(
      refusal(
        mutated((p) => {
          p.tables[0].fields[0].key = '__proto__';
        }),
      ).code,
    ).toBe('invalid-key');
    expect(({} as any).admin).toBeUndefined();
  });

  it('accepts SQL keywords as keys and loads them end to end', async () => {
    const plan = planOf([
      {
        key: 'group',
        label: 'Group',
        source: { sheet: 'G', range: 'A1:D3', headerRow: 1 },
        lookupKey: ['order'],
        fields: [
          { key: 'order', label: 'Order', type: 'text', column: 1 },
          { key: 'from', label: 'From', type: 'integer', column: 2 },
          { key: 'to', label: 'To', type: 'integer', column: 3 },
          {
            key: 'select',
            label: 'Span',
            type: 'integer',
            calculated: {
              op: 'sub',
              left: { col: 'to' },
              right: { col: 'from' },
            },
            cachedColumn: 4,
          },
        ],
      },
    ]);
    const workbook = workbookOf(
      sheetOf('G', [
        ['Order', 'From', 'To', 'Span'],
        ['a', 1, 5, { formula: 'C2-B2', value: 4 }],
        ['b', 10, 12, { formula: 'C3-B3', value: 2 }],
      ]),
    );
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({ plan, workbook, target });
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.loaded).toEqual({ group: 2 });
      expect(await target.sum('group', 'select')).toBe(6);
    } finally {
      await target.close();
    }
  });

  it('keeps reports as opaque data', () => {
    const plan = validatePlan(
      mutated((p) => {
        p.reports = [
          {
            key: 'by_parent',
            label: 'By parent',
            spec: { anything: [1, { goes: true }] },
          },
        ];
      }),
    );
    expect(plan.reports).toEqual([
      {
        key: 'by_parent',
        label: 'By parent',
        spec: { anything: [1, { goes: true }] },
      },
    ]);
  });
});
