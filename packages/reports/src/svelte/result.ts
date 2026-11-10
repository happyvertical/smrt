import { formatWidgetValue } from '@happyvertical/smrt-ui/charts/format';
import { validRuntimeReportSpec } from './spec.js';
import type { RuntimeReportResult } from './types.js';

export function reportError(
  error: unknown,
): 'reports.denied' | 'reports.invalid' | 'reports.error' {
  if (error && typeof error === 'object') {
    const e = error as { status?: unknown; code?: unknown };
    if (e.status === 401 || e.status === 403 || e.code === 'unknown_field')
      return 'reports.denied';
    if (e.code === 'invalid_result') return 'reports.invalid';
  }
  return 'reports.error';
}

/** Validate untrusted result data before formatting, including integer precision. */
export function validReportResult(
  value: unknown,
): value is RuntimeReportResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as RuntimeReportResult;
  return (
    r.version === 1 &&
    typeof r.title === 'string' &&
    typeof r.specHash === 'string' &&
    typeof r.ranAt === 'string' &&
    typeof r.truncated === 'boolean' &&
    Array.isArray(r.columns) &&
    r.columns.length > 0 &&
    r.columns.length <= 10 &&
    new Set(r.columns.map((c) => c?.id)).size === r.columns.length &&
    r.columns.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.label === 'string' &&
        ['dimension', 'measure'].includes(c.role) &&
        ['string', 'integer', 'decimal', 'boolean', 'datetime', 'id'].includes(
          c.type,
        ),
    ) &&
    Array.isArray(r.rows) &&
    r.rows.length <= 1000 &&
    r.rowCount === r.rows.length &&
    r.rows.every(
      (row) =>
        row &&
        typeof row === 'object' &&
        r.columns.every((c) => {
          const v = row[c.id];
          if (v === null) return true;
          if (c.type === 'integer')
            return typeof v === 'number' && Number.isSafeInteger(v);
          if (c.type === 'decimal')
            return typeof v === 'number' && Number.isFinite(v);
          if (c.type === 'boolean') return typeof v === 'boolean';
          return typeof v === 'string';
        }),
    ) &&
    !!r.chart &&
    ['bar', 'line', 'table', 'pie', 'stat'].includes(r.chart.type) &&
    (r.chart.y === undefined ||
      (Array.isArray(r.chart.y) &&
        r.chart.y.every((id) =>
          r.columns.some((c) => c.id === id && c.role === 'measure'),
        ))) &&
    (r.chart.x === undefined || r.columns.some((c) => c.id === r.chart.x))
  );
}

export function reportCell(
  value: unknown,
  column: RuntimeReportResult['columns'][number],
  locale: string,
  currency: string,
): string {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'number')
    return formatWidgetValue(value, {
      format:
        column.format === 'money'
          ? 'money'
          : column.type === 'integer'
            ? 'integer'
            : 'decimal',
      locale,
      currency,
    });
  return String(value);
}

/** Narrow the UI projection; canonical spec validation remains server-owned. */
export function validReportProposal(
  value: unknown,
): value is import('./types.js').RuntimeReportProposal {
  if (!value || typeof value !== 'object') return false;
  const p = value as import('./types.js').RuntimeReportProposal;
  if (
    p.status !== 'awaiting_confirmation' ||
    typeof p.specHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(p.specHash) ||
    typeof p.sourceLabel !== 'string' ||
    p.sourceLabel.length < 1 ||
    p.sourceLabel.length > 120 ||
    typeof p.confirmPath !== 'string' ||
    p.confirmPath.length > 2048 ||
    !p.confirmPath.startsWith('/') ||
    p.confirmPath.startsWith('//') ||
    !validReportResult(p.preview) ||
    p.preview.specHash !== p.specHash ||
    !p.spec
  )
    return false;
  if (!validRuntimeReportSpec(p.spec) || p.preview.title !== p.spec.title)
    return false;
  const roles = new Map<string, 'dimension' | 'measure'>([
    ...p.spec.dimensions.map((entry) => [entry.as, 'dimension'] as const),
    ...p.spec.measures.map((entry) => [entry.as, 'measure'] as const),
  ]);
  return (
    p.preview.columns.length === roles.size &&
    p.preview.columns.every((column) => roles.get(column.id) === column.role) &&
    JSON.stringify(p.preview.chart) === JSON.stringify(p.spec.chart)
  );
}
