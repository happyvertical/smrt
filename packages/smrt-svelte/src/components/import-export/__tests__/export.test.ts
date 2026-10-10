import { describe, expect, it } from 'vitest';
import { parseTable } from '../csv.js';
import {
  buildExportFile,
  selectExportFields,
  serializeCell,
} from '../export.js';
import { buildErrorReport, describeIssue } from '../report.js';
import type { ImportExportField } from '../types.js';
import { validateRows } from '../validate.js';

const fields: ImportExportField[] = [
  {
    name: 'id',
    label: 'ID',
    type: 'reference',
    required: false,
    importable: false,
    exportable: true,
  },
  {
    name: 'title',
    label: 'Title',
    type: 'text',
    required: true,
    importable: true,
    exportable: true,
  },
  {
    name: 'delta',
    label: 'Delta',
    type: 'integer',
    required: false,
    importable: true,
    exportable: true,
  },
  {
    name: 'secret',
    label: 'Secret',
    type: 'text',
    required: false,
    importable: false,
    exportable: false,
  },
  {
    name: 'meta',
    label: 'Meta',
    type: 'json',
    required: false,
    importable: true,
    exportable: true,
  },
];

describe('serializeCell', () => {
  it('renders each value kind', () => {
    expect(serializeCell(null)).toBe('');
    expect(serializeCell(undefined)).toBe('');
    expect(serializeCell(true)).toBe('true');
    expect(serializeCell(12)).toBe('12');
    expect(serializeCell(10n)).toBe('10');
    expect(serializeCell(new Date('2026-01-02T03:04:05Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
    expect(serializeCell(new Date('nope'))).toBe('');
    expect(serializeCell({ a: [1] })).toBe('{"a":[1]}');
  });
});

describe('selectExportFields', () => {
  it('drops non-exportable fields and honors the requested order', () => {
    expect(selectExportFields(fields).map((f) => f.name)).toEqual([
      'id',
      'title',
      'delta',
      'meta',
    ]);
    expect(
      selectExportFields(fields, ['meta', 'secret', 'title']).map(
        (f) => f.name,
      ),
    ).toEqual(['meta', 'title']);
  });
});

describe('buildExportFile', () => {
  const rows = [
    {
      id: '1',
      title: 'Hello, "world"',
      delta: -5,
      secret: 'x',
      meta: { k: 1 },
    },
    { id: '2', title: '=HYPERLINK("http://evil")', delta: null, meta: null },
  ];

  it('writes a BOM-prefixed CSV with name headers, selected columns, and no hidden data', () => {
    const file = buildExportFile({
      rows,
      fields,
      columns: ['id', 'title', 'delta', 'meta'],
      filename: 'my list',
    });
    expect(file.filename).toBe('my-list.csv');
    expect(file.mimeType).toContain('text/csv');
    expect(file.content.startsWith('﻿')).toBe(true);
    expect(file.content).not.toContain('secret');
    expect(file.content).not.toContain('"x"');
    expect(file.rowCount).toBe(2);
    expect(file.columnCount).toBe(4);
  });

  it('neutralizes formulas in text but keeps negative numbers intact', () => {
    const { content } = buildExportFile({ rows, fields, bom: false });
    const t = parseTable(content);
    expect(t.rows[1][1]).toBe(`'=HYPERLINK("http://evil")`);
    expect(t.rows[0][2]).toBe('-5');
    const raw = buildExportFile({
      rows,
      fields,
      bom: false,
      neutralizeFormulas: false,
    });
    expect(parseTable(raw.content).rows[1][1]).toBe(
      '=HYPERLINK("http://evil")',
    );
  });

  it('supports TSV, label headers, and no header', () => {
    const tsv = buildExportFile({
      rows,
      fields,
      format: 'tsv',
      headerStyle: 'label',
      columns: ['title', 'delta'],
    });
    expect(tsv.filename.endsWith('.tsv')).toBe(true);
    expect(tsv.content.startsWith('﻿')).toBe(false);
    expect(tsv.content.split('\r\n')[0]).toBe('Title\tDelta');
    const bare = buildExportFile({
      rows,
      fields,
      columns: ['title'],
      includeHeader: false,
      bom: false,
    });
    expect(bare.content.split('\r\n')[0]).toBe('"Hello, ""world"""');
  });

  it('exports an empty selection as an empty file', () => {
    expect(
      buildExportFile({ rows, fields, columns: [], bom: false }).content,
    ).toBe('');
  });

  it('round-trips through the importer for importable columns', () => {
    const data = [
      { title: 'A, "quoted"\nmultiline', delta: 3, meta: { n: [1, 2] } },
      { title: 'B', delta: -4, meta: null },
    ];
    const file = buildExportFile({
      rows: data,
      fields,
      columns: ['title', 'delta', 'meta'],
    });
    const table = parseTable(file.content);
    const result = validateRows({
      headers: table.headers,
      rows: table.rows,
      lines: table.lines,
      mapping: table.headers,
      fields,
    });
    expect(result.issues).toEqual([]);
    expect(result.records.map((r) => r.values)).toEqual([
      { title: 'A, "quoted"\nmultiline', delta: 3, meta: { n: [1, 2] } },
      { title: 'B', delta: -4 },
    ]);
  });
});

describe('buildErrorReport', () => {
  it('lists every issue with line, column, field, value and message', () => {
    const report = buildErrorReport([
      {
        code: 'invalid-integer',
        line: 4,
        field: 'qty',
        column: 'Qty',
        value: 'x',
      },
      { code: 'unmapped-required', line: 0, field: 'name' },
      { code: 'import-failed', line: 9, detail: 'HTTP 409' },
      {
        code: 'invalid-json',
        line: 7,
        field: 'meta',
        column: 'Meta',
        value: '=cmd|calc',
      },
    ]);
    expect(report.filename).toBe('import-errors.csv');
    const t = parseTable(report.content);
    expect(t.headers).toEqual(['line', 'column', 'field', 'value', 'problem']);
    expect(t.rows[0]).toEqual([
      '4',
      'Qty',
      'qty',
      'x',
      'Expected a whole number.',
    ]);
    expect(t.rows[1][0]).toBe('');
    expect(t.rows[2][4]).toBe('The server rejected this row. (HTTP 409)');
    expect(t.rows[3][3]).toBe("'=cmd|calc");
  });

  it('prefers supplied translations', () => {
    expect(
      describeIssue({ code: 'required', line: 1 }, { required: 'Falta' }),
    ).toBe('Falta');
  });
});
