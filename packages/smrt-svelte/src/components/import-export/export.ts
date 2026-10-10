import { formatDelimited, neutralizeFormula } from './csv.js';
import type { ExportFile, ImportExportField } from './types.js';

export type ExportFormat = 'csv' | 'tsv';

export interface BuildExportOptions {
  rows: ReadonlyArray<Record<string, unknown>>;
  fields: readonly ImportExportField[];
  /** Field names to export, in order. Defaults to every exportable field. */
  columns?: readonly string[];
  format?: ExportFormat;
  includeHeader?: boolean;
  /** `name` keeps the file re-importable by exact match; `label` is friendlier. */
  headerStyle?: 'name' | 'label';
  /** Defuse spreadsheet formula injection in text cells. Default true. */
  neutralizeFormulas?: boolean;
  /** Prefix a UTF-8 BOM (CSV only) so Excel detects the encoding. Default true. */
  bom?: boolean;
  /** Base file name without extension. Default `export`. */
  filename?: string;
}

const NUMERIC_TYPES = new Set(['integer', 'decimal', 'boolean']);

/** Fields eligible for export, honoring an explicit ordered selection. */
export function selectExportFields(
  fields: readonly ImportExportField[],
  columns?: readonly string[],
): ImportExportField[] {
  const eligible = fields.filter((f) => f.exportable);
  if (!columns) return eligible;
  const byName = new Map(eligible.map((f) => [f.name, f]));
  return columns.flatMap((name) => {
    const field = byName.get(name);
    return field ? [field] : [];
  });
}

/** Render one record value as cell text. */
export function serializeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function safeFilename(base: string): string {
  const cleaned = base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'export';
}

/** Build a downloadable CSV/TSV file from loaded rows. Pure. */
export function buildExportFile(options: BuildExportOptions): ExportFile {
  const format = options.format ?? 'csv';
  const selected = selectExportFields(options.fields, options.columns);
  const guard = options.neutralizeFormulas !== false;
  const delimiter = format === 'tsv' ? '\t' : ',';

  const table: string[][] = [];
  if (options.includeHeader !== false) {
    table.push(
      selected.map((f) => (options.headerStyle === 'label' ? f.label : f.name)),
    );
  }
  for (const row of options.rows) {
    table.push(
      selected.map((field) => {
        const text = serializeCell(row[field.name]);
        // Numbers and booleans keep their sign; only free text can carry a formula.
        return guard && !NUMERIC_TYPES.has(field.type)
          ? neutralizeFormula(text)
          : text;
      }),
    );
  }

  const body =
    selected.length === 0 ? '' : formatDelimited(table, { delimiter });
  const withBom = format === 'csv' && options.bom !== false;
  return {
    filename: `${safeFilename(options.filename ?? 'export')}.${format}`,
    mimeType:
      format === 'tsv'
        ? 'text/tab-separated-values;charset=utf-8'
        : 'text/csv;charset=utf-8',
    content: `${withBom ? '﻿' : ''}${body}`,
    rowCount: options.rows.length,
    columnCount: selected.length,
  };
}
