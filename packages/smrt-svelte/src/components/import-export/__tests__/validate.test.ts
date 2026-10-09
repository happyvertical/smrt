import { describe, expect, it } from 'vitest';
import { autoMapColumns, setColumnTarget } from '../mapping.js';
import type { ImportExportField } from '../types.js';
import { coerceCell, validateMapping, validateRows } from '../validate.js';

function field(
  over: Partial<ImportExportField> & { name: string },
): ImportExportField {
  return {
    label: over.name,
    type: 'text',
    required: false,
    importable: true,
    exportable: true,
    ...over,
  };
}

describe('coerceCell', () => {
  it('coerces integers strictly and respects the safe-integer range', () => {
    const f = field({ name: 'n', type: 'integer' });
    expect(coerceCell('42', f)).toEqual({ ok: true, value: 42 });
    expect(coerceCell('-7', f)).toEqual({ ok: true, value: -7 });
    expect(coerceCell('1.5', f)).toMatchObject({
      ok: false,
      code: 'invalid-integer',
    });
    expect(coerceCell('1e3', f)).toMatchObject({
      ok: false,
      code: 'invalid-integer',
    });
    expect(coerceCell('9007199254740993', f)).toMatchObject({
      ok: false,
      code: 'out-of-range',
    });
  });

  it('coerces decimals', () => {
    const f = field({ name: 'r', type: 'decimal' });
    expect(coerceCell('0.85', f)).toEqual({ ok: true, value: 0.85 });
    expect(coerceCell('.5', f)).toEqual({ ok: true, value: 0.5 });
    expect(coerceCell('1,5', f)).toMatchObject({
      ok: false,
      code: 'invalid-decimal',
    });
    expect(coerceCell('NaN', f)).toMatchObject({ ok: false });
  });

  it('coerces booleans from common spreadsheet words', () => {
    const f = field({ name: 'b', type: 'boolean' });
    for (const yes of ['true', 'YES', 'y', '1', 'On']) {
      expect(coerceCell(yes, f)).toEqual({ ok: true, value: true });
    }
    for (const no of ['false', 'No', 'n', '0', 'off']) {
      expect(coerceCell(no, f)).toEqual({ ok: true, value: false });
    }
    expect(coerceCell('maybe', f)).toMatchObject({
      ok: false,
      code: 'invalid-boolean',
    });
  });

  it('normalizes ISO datetimes to UTC and rejects ambiguous or impossible ones', () => {
    const f = field({ name: 'd', type: 'datetime' });
    expect(coerceCell('2026-03-05', f)).toEqual({
      ok: true,
      value: '2026-03-05T00:00:00.000Z',
    });
    expect(coerceCell('2026-03-05 09:30', f)).toEqual({
      ok: true,
      value: '2026-03-05T09:30:00.000Z',
    });
    expect(coerceCell('2026-03-05T09:30:00-05:00', f)).toEqual({
      ok: true,
      value: '2026-03-05T14:30:00.000Z',
    });
    expect(coerceCell('2026-03-05T09:30:00.5Z', f)).toEqual({
      ok: true,
      value: '2026-03-05T09:30:00.500Z',
    });
    expect(coerceCell('3/5/2026', f)).toMatchObject({
      ok: false,
      code: 'invalid-datetime',
    });
    expect(coerceCell('2026-02-30', f)).toMatchObject({
      ok: false,
      code: 'invalid-datetime',
    });
    expect(coerceCell('2026-03-05T25:00', f)).toMatchObject({
      ok: false,
      code: 'invalid-datetime',
    });
  });

  it('parses json, enum (case-insensitive, canonical), references, email and url', () => {
    expect(coerceCell('{"a":1}', field({ name: 'j', type: 'json' }))).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(
      coerceCell('{oops', field({ name: 'j', type: 'json' })),
    ).toMatchObject({
      ok: false,
      code: 'invalid-json',
    });
    const e = field({
      name: 's',
      type: 'enum',
      options: ['draft', 'Published'],
    });
    expect(coerceCell('PUBLISHED', e)).toEqual({
      ok: true,
      value: 'Published',
    });
    expect(coerceCell('gone', e)).toMatchObject({
      ok: false,
      code: 'invalid-enum',
      detail: 'draft, Published',
    });
    expect(
      coerceCell('a b', field({ name: 'r', type: 'reference' })),
    ).toMatchObject({ ok: false });
    expect(
      coerceCell('x@y', field({ name: 'm', widget: 'email' })),
    ).toMatchObject({ ok: false, code: 'invalid-email' });
    expect(
      coerceCell('a@b.co', field({ name: 'm', widget: 'email' })),
    ).toMatchObject({ ok: true });
    expect(
      coerceCell('javascript:alert(1)', field({ name: 'u', widget: 'url' })),
    ).toMatchObject({
      ok: false,
      code: 'invalid-url',
    });
    expect(
      coerceCell('https://example.test/x', field({ name: 'u', widget: 'url' })),
    ).toMatchObject({ ok: true });
  });

  it('restores formula-neutralized text', () => {
    expect(coerceCell("'=SUM(A1)", field({ name: 't' }))).toEqual({
      ok: true,
      value: '=SUM(A1)',
    });
  });
});

describe('autoMapColumns', () => {
  const fields = [
    field({ name: 'firstName', label: 'First name' }),
    field({ name: 'email', aliases: ['E-mail address'] }),
    field({ name: 'id', importable: false }),
  ];

  it('matches by name, label and alias across spelling styles', () => {
    expect(
      autoMapColumns(['First Name', 'e-mail address', 'id', 'extra'], fields),
    ).toEqual(['firstName', 'email', null, null]);
    expect(autoMapColumns(['first_name', 'EMAIL'], fields)).toEqual([
      'firstName',
      'email',
    ]);
  });

  it('maps a field to only the first matching column', () => {
    expect(autoMapColumns(['email', 'Email'], fields)).toEqual(['email', null]);
  });

  it('setColumnTarget moves a field instead of duplicating it', () => {
    expect(setColumnTarget(['email', null], 1, 'email')).toEqual([
      null,
      'email',
    ]);
    expect(setColumnTarget(['email', 'x'], 1, null)).toEqual(['email', null]);
  });
});

describe('validateMapping', () => {
  const fields = [
    field({ name: 'name', required: true }),
    field({ name: 'note' }),
    field({
      name: 'status',
      required: true,
      hasDefault: true,
      defaultValue: 'new',
    }),
  ];

  it('reports duplicate targets and unmapped required fields without defaults', () => {
    const issues = validateMapping(['a', 'b'], ['note', 'note'], fields);
    expect(issues.map((i) => i.code).sort()).toEqual([
      'duplicate-mapping',
      'unmapped-required',
    ]);
    expect(issues.find((i) => i.code === 'unmapped-required')?.field).toBe(
      'name',
    );
  });

  it('is clean for a sound mapping', () => {
    expect(validateMapping(['a'], ['name'], fields)).toEqual([]);
  });
});

describe('validateRows', () => {
  const fields: ImportExportField[] = [
    field({ name: 'name', required: true }),
    field({ name: 'qty', type: 'integer' }),
    field({ name: 'sku', unique: true }),
    field({
      name: 'status',
      type: 'enum',
      options: ['new', 'done'],
      hasDefault: true,
      defaultValue: 'new',
    }),
    field({
      name: 'locked',
      importable: false,
      hasDefault: true,
      defaultValue: 'L',
    }),
  ];
  const headers = ['Name', 'Qty', 'SKU'];
  const mapping = ['name', 'qty', 'sku'];

  it('builds typed records, applies defaults, and skips empty cells', () => {
    const r = validateRows({
      headers,
      mapping,
      fields,
      rows: [
        ['Widget', '3', 'W-1'],
        ['Gadget', '', 'G-1'],
      ],
    });
    expect(r.invalidRows).toBe(0);
    expect(r.records.map((x) => x.values)).toEqual([
      { name: 'Widget', qty: 3, sku: 'W-1', status: 'new', locked: 'L' },
      { name: 'Gadget', sku: 'G-1', status: 'new', locked: 'L' },
    ]);
  });

  it('reports row issues with file lines and keeps valid rows separate', () => {
    const r = validateRows({
      headers,
      mapping,
      fields,
      rows: [
        ['Widget', '3', 'W-1'],
        ['', 'x', 'W-2'],
        ['Dup', '1', 'W-1'],
      ],
      lines: [2, 3, 5],
    });
    expect(r.records.map((x) => x.line)).toEqual([2]);
    expect(r.invalidRows).toBe(2);
    expect(r.issues.map((i) => [i.line, i.code, i.field])).toEqual([
      [3, 'invalid-integer', 'qty'],
      [3, 'required', 'name'],
      [5, 'duplicate-value', 'sku'],
    ]);
    expect(r.issues[0]).toMatchObject({ column: 'Qty', value: 'x' });
  });

  it('does not let a rejected row reserve a unique value', () => {
    const r = validateRows({
      headers,
      mapping,
      fields,
      rows: [
        ['', '', 'S-1'],
        ['Real', '', 'S-1'],
      ],
    });
    expect(r.records).toHaveLength(1);
    expect(r.issues.map((i) => i.code)).toEqual(['required']);
  });

  it('never imports when the mapping is unsound, and never maps a non-importable field', () => {
    const r = validateRows({
      headers: ['Qty', 'Locked'],
      mapping: ['qty', 'locked'],
      fields,
      rows: [['1', 'attempt']],
    });
    expect(r.mappingIssues.map((i) => i.code)).toEqual(['unmapped-required']);
    expect(r.records).toEqual([]);

    const ok = validateRows({
      headers: ['Name', 'Locked'],
      mapping: ['name', 'locked'],
      fields,
      rows: [['N', 'attempt']],
    });
    expect(ok.records[0].values.locked).toBe('L');
  });

  it('flags rows with more cells than headers', () => {
    const r = validateRows({
      headers: ['Name'],
      mapping: ['name'],
      fields,
      rows: [['a', 'b']],
    });
    expect(r.issues[0].code).toBe('extra-cells');
    expect(r.records).toEqual([]);
  });

  it('caps stored issues but keeps counting invalid rows', () => {
    const rows = Array.from({ length: 10 }, () => ['', '', '']);
    const r = validateRows({ headers, mapping, fields, rows, maxIssues: 3 });
    expect(r.invalidRows).toBe(10);
    expect(r.issues).toHaveLength(3);
    expect(r.issuesTruncated).toBe(true);
  });

  it('truncates echoed values', () => {
    const r = validateRows({
      headers: ['Qty'],
      mapping: ['qty'],
      fields: [field({ name: 'qty', type: 'integer' })],
      rows: [['x'.repeat(500)]],
    });
    expect(r.issues[0].value?.length).toBeLessThanOrEqual(201);
  });
});
