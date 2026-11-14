import { formatWidgetValue } from '@happyvertical/smrt-ui/charts/format';
import { validReportResult } from '../display.js';
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

export { validReportResult } from '../display.js';

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
